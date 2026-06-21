#!/usr/bin/env node
/**
 * SUUMOスカウト — 週次物件評価バッチ
 *
 * Anthropic API (web_search) で SUUMO/LIFULL HOME'S の新着物件を検索し、
 * こだわり条件で評価したうえで Slack チャンネルに投稿する。
 *
 * 必要な環境変数（GitHub Secrets経由で渡す）:
 *   ANTHROPIC_API_KEY  - Anthropic API キー
 *   SLACK_BOT_TOKEN    - Slack Bot User OAuth Token (xoxb-...)
 *   SLACK_CHANNEL_ID   - 投稿先チャンネルID (例: C0BBWK83P4K)
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

if (!ANTHROPIC_API_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error("必要な環境変数が不足しています: ANTHROPIC_API_KEY / SLACK_BOT_TOKEN / SLACK_CHANNEL_ID");
  process.exit(1);
}

// ── こだわり条件（ここを変えれば評価基準を調整できます） ──────────────
const AREAS = ["港区", "渋谷区", "品川区", "目黒区"];
const RENT_MIN = 10; // 万円
const RENT_MAX = 14; // 万円
const FLOOR_TARGET = "8〜12階";
const ACCESS_TARGET = "神谷町駅または六本木一丁目駅まで35分以内";
const LAYOUT_MIN = "1LDK以上";

const SYSTEM_PROMPT = `あなたは不動産物件の評価AIです。web_searchツールを使って、SUUMOまたはLIFULL HOME'Sに掲載されている、以下の条件に合う新着・更新の賃貸物件情報を探してください。

【検索エリア】
${AREAS.join("・")}

【こだわり条件（評価基準）】
1. 夕陽が綺麗に見える（最重要）
   - 物件の向き（西〜南西向き）の記載を確認する
   - 住所周辺（半径150m程度）に視界を遮る高層建物が多いかどうかを地理的知識で推定する
   - 「西〜南西向き」かつ「周辺に高い建物が少ない」場合は ok
   - 「西〜南西向き」だが「高層ビル密集地」の場合は partial（視界要確認の旨を明記）
   - 東〜北向き、または不明な場合は ng または unknown
2. 階数：${FLOOR_TARGET} が理想（それ以外は減点）
3. 家賃：${RENT_MIN}〜${RENT_MAX}万円なら ok、範囲外は減点
4. アクセス：${ACCESS_TARGET}（日比谷線・南北線沿線が有利）
5. 間取り：${LAYOUT_MIN}

スコアの目安: S=85点以上 / A=70〜84点 / B=50〜69点 / C=49点以下

物件を全て評価し終えたら、最後に必ず report_properties ツールを呼び出して結果を報告してください。`;

const REPORT_TOOL = {
  name: "report_properties",
  description: "評価した物件一覧を報告する。物件検索・評価が完了したら必ずこのツールを呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      properties: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name:       { type: "string" },
            meta:       { type: "string" },
            rentNum:    { type: "number" },
            score:      { type: "integer" },
            rank:       { type: "string", enum: ["S", "A", "B", "C"] },
            url:        { type: "string" },
            criteria: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label:  { type: "string" },
                  result: { type: "string", enum: ["ok", "partial", "ng", "unknown"] },
                },
                required: ["label", "result"],
              },
            },
            sunsetNote: { type: "string" },
            reason:     { type: "string" },
          },
          required: ["name", "score", "rank", "criteria"],
        },
      },
    },
    required: ["properties"],
  },
};

const RANK_ICON = { S: "🟣", A: "🟢", B: "🟡", C: "⚪" };
const RESULT_ICON = { ok: "✅", partial: "🔶", ng: "❌", unknown: "❔" };

async function callClaude() {
  const messages = [
    {
      role: "user",
      content: "上記の条件に合うSUUMO/LIFULL HOME'Sの新着・更新物件をWeb検索で探して、見つかった分だけ全件評価し、report_propertiesツールで報告してください。",
    },
  ];

  // Claude がすべてのツール呼び出し（web_search + report_properties）を完了するまでループ
  while (true) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search" }, REPORT_TOOL],
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API error (${resp.status}): ${errText}`);
    }

    const data = await resp.json();

    // report_properties が呼ばれたら結果を返す
    const reportBlock = data.content.find(
      (b) => b.type === "tool_use" && b.name === "report_properties"
    );
    if (reportBlock) {
      return reportBlock.input.properties || [];
    }

    // stop_reason が end_turn でツールなし → 物件なし
    if (data.stop_reason === "end_turn") {
      return [];
    }

    // tool_use が続く場合はメッセージを継続（web_search の結果を返す）
    messages.push({ role: "assistant", content: data.content });
    const toolResults = data.content
      .filter((b) => b.type === "tool_use" && b.name !== "report_properties")
      .map((b) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content: "",
      }));
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }
}

function buildSlackMessage(properties) {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  if (properties.length === 0) {
    return [
      `*🏠 SUUMOスカウト 週次サマリー（${today}）*`,
      "",
      "今週は条件に合う新着物件が見つかりませんでした。",
      `検索エリア: ${AREAS.join("・")} / 家賃${RENT_MIN}〜${RENT_MAX}万円 / ${LAYOUT_MIN}`,
    ].join("\n");
  }

  const sorted = [...properties].sort((a, b) => (b.score || 0) - (a.score || 0));
  const sCount = sorted.filter((p) => p.rank === "S").length;
  const aCount = sorted.filter((p) => p.rank === "A").length;

  const lines = [
    `*🏠 SUUMOスカウト 週次サマリー（${today}）*`,
    `見つかった物件: ${sorted.length}件　|　Sランク: ${sCount}件　Aランク: ${aCount}件`,
    "",
  ];

  for (const p of sorted) {
    const rankIcon = RANK_ICON[p.rank] || "⚪";
    lines.push(`${rankIcon} *${p.rank}ランク（${p.score ?? "?"}点）* — ${p.name || "（名称不明）"}`);
    if (p.meta) lines.push(`> ${p.meta}`);

    const critLine = (p.criteria || [])
      .map((c) => `${RESULT_ICON[c.result] || "❔"} ${c.label}`)
      .join("　");
    if (critLine) lines.push(`> ${critLine}`);

    if (p.sunsetNote) lines.push(`> 🌇 ${p.sunsetNote}`);
    if (p.reason) lines.push(`> ${p.reason}`);
    if (p.url) lines.push(`> <${p.url}|物件を見る>`);
    lines.push("");
  }

  lines.push(
    `_検索条件: ${AREAS.join("・")} / 家賃${RENT_MIN}〜${RENT_MAX}万円 / ${LAYOUT_MIN} / ${ACCESS_TARGET}_`
  );

  return lines.join("\n");
}

async function postToSlack(text) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text,
      unfurl_links: false,
    }),
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Slack投稿に失敗しました: ${data.error}`);
  }
  return data;
}

async function main() {
  console.log("SUUMOスカウト: 物件検索・評価を開始します...");
  let properties = [];
  try {
    properties = await callClaude();
    console.log(`評価完了: ${properties.length}件の物件を取得しました`);
  } catch (err) {
    console.error("物件の検索・評価に失敗しました:", err.message);
    await postToSlack(
      `⚠️ *SUUMOスカウト実行エラー*\n物件の検索・評価に失敗しました。\n\`\`\`${err.message.slice(0, 500)}\`\`\``
    );
    process.exit(1);
  }

  const message = buildSlackMessage(properties);
  console.log("Slackへ投稿します...");
  await postToSlack(message);
  console.log("完了しました。");
}

main().catch((err) => {
  console.error("予期しないエラー:", err);
  process.exit(1);
});
