import AVFoundation
import ExpoModulesCore

/// Microphone -> 16 kHz mono Int16 -> base64 "onFrames" events, about every 100 ms.
public class BibblyAudioModule: Module {
  private let engine = AVAudioEngine()
  private var converter: AVAudioConverter?
  private var outFormat: AVAudioFormat?
  private var pending = Data()
  private var running = false

  public func definition() -> ModuleDefinition {
    Name("BibblyAudio")
    Events("onFrames", "onError")

    AsyncFunction("start") { (sampleRate: Double, promise: Promise) in
      self.requestPermission { granted in
        guard granted else {
          promise.reject("E_MIC_PERMISSION", "Microphone access is off for Bibbly. Turn it on in Settings.")
          return
        }
        do {
          try self.startEngine(sampleRate: sampleRate)
          promise.resolve(nil)
        } catch {
          promise.reject("E_MIC_START", error.localizedDescription)
        }
      }
    }

    AsyncFunction("stop") {
      self.stopEngine()
    }

    Function("isRecording") {
      return self.running
    }

    OnDestroy {
      self.stopEngine()
    }
  }

  private func requestPermission(_ done: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { done($0) }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { done($0) }
    }
  }

  private func startEngine(sampleRate: Double) throws {
    if running { return }
    let session = AVAudioSession.sharedInstance()
    // Measurement mode skips voice processing, so the whole room is captured, not just the nearest voice.
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers])
    try session.setActive(true)

    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard let out = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true),
          let conv = AVAudioConverter(from: inFormat, to: out) else {
      throw NSError(domain: "BibblyAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "This microphone format is not supported."])
    }
    converter = conv
    outFormat = out
    pending.removeAll()
    input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
      self?.handle(buffer)
    }
    engine.prepare()
    try engine.start()
    running = true
  }

  private func handle(_ buffer: AVAudioPCMBuffer) {
    guard let conv = converter, let out = outFormat else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * out.sampleRate / buffer.format.sampleRate) + 32
    guard let pcm = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    conv.convert(to: pcm, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    if let error {
      sendEvent("onError", ["message": error.localizedDescription])
      return
    }
    guard pcm.frameLength > 0, let channel = pcm.int16ChannelData else { return }
    pending.append(Data(bytes: channel[0], count: Int(pcm.frameLength) * 2))
    let chunk = Int(out.sampleRate / 10) * 2 // 100 ms
    while pending.count >= chunk {
      let piece = pending.prefix(chunk)
      pending.removeFirst(chunk)
      sendEvent("onFrames", ["pcm": piece.base64EncodedString(), "sampleRate": out.sampleRate])
    }
  }

  private func stopEngine() {
    guard running else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    running = false
    pending.removeAll()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
