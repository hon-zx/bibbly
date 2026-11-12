import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { guessMixed, normLang, speechTag } from '../lang.js';
import { BaseSpeechStream, type SpeechProvider, type SpeechStream, type SpeechStreamOptions } from './provider.js';

export interface AzureSpeechConfig {
  key: string;
  region: string;
}

/**
 * Azure AI Speech with continuous language identification: the language is
 * re-detected throughout the stream (up to 10 candidates), so a meeting that
 * moves between Mandarin, English and Japanese is followed phrase by phrase.
 * With diarize=true it uses ConversationTranscriber to label speakers.
 */
export class AzureSpeechProvider implements SpeechProvider {
  readonly id = 'azure';
  readonly label = 'Azure AI Speech';
  readonly detectsLanguage = true;
  constructor(private readonly cfg: AzureSpeechConfig) {}

  async start(opts: SpeechStreamOptions): Promise<SpeechStream> {
    const stream = new AzureStream(this.cfg, opts);
    await stream.begin();
    return stream;
  }
}

class AzureStream extends BaseSpeechStream {
  private readonly push: sdk.PushAudioInputStream;
  private readonly recognizer: sdk.SpeechRecognizer | sdk.ConversationTranscriber;
  private closed = false;

  constructor(cfg: AzureSpeechConfig, private readonly opts: SpeechStreamOptions) {
    super();
    const speechConfig = sdk.SpeechConfig.fromSubscription(cfg.key, cfg.region);
    speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
    const candidates = [...new Set(opts.candidateLanguages.map(speechTag))].slice(0, 10);
    const autoDetect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(candidates.length ? candidates : ['en-US', 'zh-CN']);
    this.push = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(opts.sampleRate, 16, 1));
    const audioConfig = sdk.AudioConfig.fromStreamInput(this.push);
    this.recognizer = opts.diarize
      ? sdk.ConversationTranscriber.FromConfig(speechConfig, autoDetect, audioConfig)
      : sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);
    if (opts.phrases?.length) {
      const list = sdk.PhraseListGrammar.fromRecognizer(this.recognizer as sdk.SpeechRecognizer);
      opts.phrases.forEach(p => list.addPhrase(p));
    }
  }

  async begin(): Promise<void> {
    const r = this.recognizer;
    const onPartial = (result: sdk.RecognitionResult) => {
      if (result.text) this.result({ text: result.text, final: false, ...this.meta(result) });
    };
    const onFinal = (result: sdk.RecognitionResult) => {
      if (result.reason !== sdk.ResultReason.RecognizedSpeech || !result.text) return;
      const langs = guessMixed(result.text);
      this.result({ text: result.text, final: true, ...this.meta(result), ...(langs ? { langs } : {}),
                    start: result.offset / 1e7, end: (result.offset + result.duration) / 1e7 });
    };
    const onCanceled = (e: sdk.SpeechRecognitionCanceledEventArgs | sdk.ConversationTranscriptionCanceledEventArgs) => {
      if (e.reason === sdk.CancellationReason.Error) this.error(new Error(`Azure Speech stopped: ${e.errorDetails}`));
    };
    if (r instanceof sdk.ConversationTranscriber) {
      r.transcribing = (_s, e) => onPartial(e.result);
      r.transcribed = (_s, e) => onFinal(e.result);
      r.canceled = (_s, e) => onCanceled(e);
      await new Promise<void>((res, rej) => r.startTranscribingAsync(() => res(), err => rej(new Error(err))));
    } else {
      r.recognizing = (_s, e) => onPartial(e.result);
      r.recognized = (_s, e) => onFinal(e.result);
      r.canceled = (_s, e) => onCanceled(e);
      await new Promise<void>((res, rej) => r.startContinuousRecognitionAsync(() => res(), err => rej(new Error(err))));
    }
  }

  private meta(result: sdk.RecognitionResult) {
    const detected = sdk.AutoDetectSourceLanguageResult.fromResult(result as unknown as sdk.SpeechRecognitionResult);
    const lang = normLang(detected.language);
    const speakerId = (result as unknown as { speakerId?: string }).speakerId;
    return { ...(lang ? { lang } : {}), ...(speakerId && speakerId !== 'Unknown' ? { speakerId } : {}) };
  }

  write(frame: Int16Array): void {
    if (this.closed) return;
    this.push.write(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.push.close();
    const r = this.recognizer;
    await new Promise<void>(res => {
      if (r instanceof sdk.ConversationTranscriber) r.stopTranscribingAsync(() => res(), () => res());
      else r.stopContinuousRecognitionAsync(() => res(), () => res());
    });
    r.close();
  }
}
