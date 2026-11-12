import type { ActionItem, Clarity, ClarityItem, LangCode } from './types.js';
import type { ClarityEngine, ClarityRequest, ClarityResult, TranslateRequest, TranslateResult, Translator } from './llm/types.js';
import { dueFrom, type DueRule } from './dates.js';

export interface DemoSpeaker { id: string; name: string; native?: string; city: string; reads: LangCode }
export interface DemoLine { t: number; speaker: string; lang: LangCode; langs?: LangCode[]; confidence: number; text: string; tr: Record<LangCode, string> }

/** The bilingual demo meeting used by the scripted speech provider and first-run demo notes. */
export const DEMO_MEETING = {
  title: 'Q4 launch sync: Shanghai × Singapore × Tokyo',
  speakers: [
    { id: 'li', name: 'Li Wei', native: '李伟', city: 'Shanghai', reads: 'zh' },
    { id: 'jun', name: 'Jun Lim', city: 'Singapore', reads: 'en' },
    { id: 'sato', name: 'Sato Yuki', native: '佐藤 由紀', city: 'Tokyo', reads: 'ja' },
    { id: 'me', name: 'You', city: 'Singapore', reads: 'en' },
  ] as DemoSpeaker[],
  lines: [
    { t: 4, speaker: 'li', lang: 'zh', confidence: 0.98, text: '大家好，我们开始吧。今天主要确认 Nimbus Lite 在新加坡和日本的上市时间。',
      tr: { en: "Hi everyone, let's get started. Today we mainly need to confirm the Nimbus Lite launch dates for Singapore and Japan.", ja: '皆さん、こんにちは。始めましょう。今日は主に、Nimbus Lite のシンガポールと日本での発売日を確認したいと思います。' } },
    { t: 19, speaker: 'jun', lang: 'en', confidence: 0.99, text: 'Thanks, Li Wei. Singapore is ready on our side. Our retail partners confirmed shelf space from November 28.',
      tr: { zh: '谢谢李伟。新加坡这边已经准备好了，零售合作伙伴确认从 11 月 28 日起提供货架位置。', ja: 'ありがとうございます、李偉さん。シンガポール側は準備ができています。小売パートナーから、11 月 28 日から棚を確保できると確認が取れました。' } },
    { t: 41, speaker: 'sato', lang: 'ja', confidence: 0.97, text: '日本は少し遅れそうです。パッケージの日本語表記を最終確認する必要があります。',
      tr: { en: 'Japan may be slightly delayed. We still need a final check of the Japanese text on the packaging.', zh: '日本可能会稍微晚一点。我们还需要最后确认包装上的日文标示。' } },
    { t: 63, speaker: 'li', lang: 'zh', confidence: 0.98, text: '没问题。佐藤女士，包装文件我今天下班前发给您，你们两天内能确认吗？',
      tr: { en: "No problem. Ms. Sato, I'll send you the packaging files before the end of today. Can your team confirm within two days?", ja: '問題ありません。佐藤さん、パッケージのデータを今日の終業までにお送りします。2 日以内にご確認いただけますか？' } },
    { t: 84, speaker: 'sato', lang: 'ja', confidence: 0.97, text: 'はい、2 日以内に確認します。それなら日本の発売は 12 月 5 日で大丈夫です。',
      tr: { en: "Yes, we'll confirm within two days. In that case, December 5 works for the Japan launch.", zh: '好的，我们两天内确认。这样的话，日本 12 月 5 日上市没问题。' } },
    { t: 106, speaker: 'jun', lang: 'en', langs: ['en', 'zh'], confidence: 0.93, text: 'Great. So 我们 lock 两个日期: Singapore November 28, Japan December 5. 价格 also need to finalize by end of the week, can?',
      tr: { en: 'Great. So we lock both dates: Singapore on November 28 and Japan on December 5. Pricing also needs to be finalized by the end of the week. Okay?', zh: '太好了。那我们锁定两个日期：新加坡 11 月 28 日，日本 12 月 5 日。价格也需要在这周结束前定下来，可以吗？', ja: 'いいですね。では 2 つの日程で確定しましょう。シンガポールは 11 月 28 日、日本は 12 月 5 日です。価格も今週中に確定する必要がありますが、よろしいですか？' } },
    { t: 131, speaker: 'li', lang: 'zh', confidence: 0.98, text: '可以。新加坡定价 129 新元，日本我建议含税 13,800 日元。',
      tr: { en: 'Sure. Singapore at S$129, and for Japan I suggest ¥13,800 including tax.', ja: '大丈夫です。シンガポールは 129 シンガポールドル、日本は税込 13,800 円を提案します。' } },
    { t: 150, speaker: 'me', lang: 'en', confidence: 0.99, text: "Works for me. I'll get final sign-off from finance by the end of the week. Jun, can you update the launch deck with both prices and share it in Slack by tomorrow?",
      tr: { zh: '我这边没问题。我会在这周结束前拿到财务的最终批准。Jun，你能把两个价格更新到发布资料里，明天之前发到 Slack 上吗？', ja: '私はそれで問題ありません。今週中に財務の最終承認を取ります。Jun さん、両方の価格を発表資料に反映して、明日までに Slack で共有してもらえますか？' } },
    { t: 167, speaker: 'jun', lang: 'en', confidence: 0.99, text: "Sure, I'll post it in Slack by tomorrow noon.",
      tr: { zh: '没问题，我明天中午前发到 Slack。', ja: '了解です。明日の正午までに Slack に投稿します。' } },
    { t: 181, speaker: 'sato', lang: 'ja', confidence: 0.96, text: 'もう一点、日本向けのプロモーション動画に英語字幕は必要ですか？',
      tr: { en: 'One more thing: do we need English subtitles on the promo video for Japan?', zh: '还有一点，日本的宣传视频需要英文字幕吗？' } },
    { t: 196, speaker: 'li', lang: 'zh', confidence: 0.98, text: '需要，英文和中文字幕都加上。字幕文件我明天发给您。',
      tr: { en: "Yes, please add both English and Chinese subtitles. I'll send you the subtitle files tomorrow.", ja: '必要です。英語と中国語の両方の字幕を入れてください。字幕ファイルは明日お送りします。' } },
    { t: 214, speaker: 'me', lang: 'en', confidence: 0.99, text: "Perfect. Let's regroup next Tuesday at 10 to review the final packaging. Thanks, everyone!",
      tr: { zh: '太好了。我们下周二上午 10 点再碰一次，确认最终包装。谢谢大家！', ja: '完璧です。来週の火曜日 10 時に、最終パッケージの確認のためにもう一度集まりましょう。皆さん、ありがとうございました！' } },
  ] as DemoLine[],
};

/* ------------------------------------------------------------------ */
/* Offline demo engines: baked translations and notes for the demo    */
/* meeting, so the apps work with no API keys. Real meetings use Claude. */
/* ------------------------------------------------------------------ */

type T3 = { en: string; zh: string; ja: string };
const DEMO_NOTES: {
  summary: { after: number; text: T3 }[];
  decisions: { after: number; text: T3 }[];
  actions: { id: string; after: number; owner: string; me: boolean; due: DueRule; line: number; text: T3 }[];
  followup: { after: number; when: DueRule; minutes: number; text: T3 };
} = {
  summary: [
    { after: 5, text: { en: 'Japan depends on a final check of the Japanese packaging text, due within two days.', zh: '日本上市取决于包装日文标示的最终确认，需在两天内完成。', ja: '日本の発売は、パッケージの日本語表記の最終確認（2 日以内）が前提。' } },
    { after: 6, text: { en: 'Launch dates locked: Singapore on Nov 28, Japan on Dec 5.', zh: '上市日期已确定：新加坡 11 月 28 日，日本 12 月 5 日。', ja: '発売日が確定：シンガポールは 11 月 28 日、日本は 12 月 5 日。' } },
    { after: 8, text: { en: 'Proposed prices: S$129 in Singapore, ¥13,800 incl. tax in Japan; finance signs off by end of week.', zh: '建议价格：新加坡 129 新元，日本含税 13,800 日元；本周内完成财务审批。', ja: '提案価格：シンガポール 129 シンガポールドル、日本は税込 13,800 円。今週中に財務が承認。' } },
  ],
  decisions: [
    { after: 6, text: { en: 'Launch dates: Singapore Nov 28 · Japan Dec 5', zh: '上市日期：新加坡 11 月 28 日 · 日本 12 月 5 日', ja: '発売日：シンガポール 11 月 28 日・日本 12 月 5 日' } },
    { after: 7, text: { en: 'Prices: S$129 (SG) · ¥13,800 incl. tax (JP), pending finance', zh: '价格：新加坡 129 新元 · 日本含税 13,800 日元（待财务批准）', ja: '価格：129 シンガポールドル（SG）・税込 13,800 円（JP）、財務承認待ち' } },
    { after: 11, text: { en: 'Japan promo video gets English and Chinese subtitles', zh: '日本宣传视频加上英文和中文字幕', ja: '日本向けプロモ動画に英語と中国語の字幕を追加' } },
  ],
  actions: [
    { id: 'demo-a1', after: 4, owner: 'Li Wei', me: false, due: { days: 0, time: '18:00' }, line: 4, text: { en: 'Send packaging files to Sato', zh: '把包装文件发给佐藤', ja: 'パッケージデータを佐藤さんに送る' } },
    { id: 'demo-a2', after: 5, owner: 'Sato Yuki', me: false, due: { days: 2 }, line: 5, text: { en: 'Confirm the Japanese packaging text', zh: '确认包装上的日文标示', ja: 'パッケージの日本語表記を確認する' } },
    { id: 'demo-a3', after: 8, owner: 'You', me: true, due: { weekday: 'fri', time: '17:00' }, line: 8, text: { en: 'Get finance sign-off on Nimbus Lite pricing', zh: '拿到财务对 Nimbus Lite 价格的最终批准', ja: 'Nimbus Lite の価格について財務の最終承認を取る' } },
    { id: 'demo-a4', after: 9, owner: 'Jun Lim', me: false, due: { days: 1, time: '12:00' }, line: 9, text: { en: 'Update the launch deck with both prices and post it in Slack', zh: '把两个价格更新到发布资料并发到 Slack', ja: '両方の価格を発表資料に反映して Slack に投稿する' } },
    { id: 'demo-a5', after: 11, owner: 'Li Wei', me: false, due: { days: 1 }, line: 11, text: { en: 'Send English and Chinese subtitle files for the Japan promo', zh: '发送日本宣传视频的中英文字幕文件', ja: '日本向けプロモ動画の英語・中国語字幕ファイルを送る' } },
  ],
  followup: { after: 12, when: { nextWeek: 2, time: '10:00' }, minutes: 45, text: { en: 'Packaging review', zh: '包装审核会', ja: 'パッケージ最終確認' } },
};

const DEMO_TEXT = new Map(DEMO_MEETING.lines.map(l => [l.text, l]));
const pick = (t: T3): Record<string, string> => ({ en: t.en, zh: t.zh, ja: t.ja });

/** Translator for the demo meeting: baked translations, then an optional real translator for other text or languages. */
export class DemoTranslator implements Translator {
  constructor(private readonly fallback: Translator | null = null) {}
  async translate(req: TranslateRequest, signal?: AbortSignal): Promise<TranslateResult[]> {
    const baked: TranslateResult[] = [];
    const rest = [];
    for (const item of req.items) {
      const d = DEMO_TEXT.get(item.text);
      const t = d ? d.tr[req.target] ?? (d.lang === req.target && !d.langs ? d.text : undefined) : undefined;
      if (d && t) baked.push({ id: item.id, translation: t, lang: d.lang, langs: d.langs ?? [], confidence: d.confidence });
      else rest.push(item);
    }
    if (rest.length && this.fallback) return [...baked, ...(await this.fallback.translate({ ...req, items: rest }, signal))];
    if (rest.length && !baked.length) throw new Error('Translating outside the demo needs a Claude API key (Settings).');
    return baked;
  }
}

/** Notes for the demo meeting that grow as the meeting goes, in English, 中文 and 日本語. */
export class DemoClarity implements ClarityEngine {
  constructor(private readonly fallback: ClarityEngine | null = null) {}
  async summarize(req: ClarityRequest, signal?: AbortSignal): Promise<ClarityResult> {
    const demo = req.lines.length > 0 && req.lines.every(l => DEMO_TEXT.has(l.text));
    if (!demo && this.fallback) return this.fallback.summarize(req, signal);
    const n = req.lines.length;
    const src = (['en', 'zh', 'ja'] as const).includes(req.lang as 'en') ? req.lang : 'en';
    const item = (t: T3): ClarityItem => ({ src, text: pick(t) });
    const actions: ActionItem[] = DEMO_NOTES.actions.filter(a => a.after <= n).map(a => {
      const line = req.lines.find(l => l.text === DEMO_MEETING.lines[a.line - 1]?.text);
      return { ...item(a.text), id: a.id, owner: a.owner, ownerIsMe: a.me, due: dueFrom(req.startedAt, a.due).getTime(), ...(line ? { lineId: line.id } : {}) };
    });
    const f = DEMO_NOTES.followup;
    const clarity: Clarity = {
      summary: DEMO_NOTES.summary.filter(s => s.after <= n).map(s => item(s.text)),
      decisions: DEMO_NOTES.decisions.filter(d => d.after <= n).map(d => item(d.text)),
      actions,
      followup: f.after <= n ? { ...item(f.text), when: dueFrom(req.startedAt, f.when).getTime(), durationMin: f.minutes } : null,
      updatedAt: Date.now(),
    };
    return { title: DEMO_MEETING.title, clarity };
  }
}
