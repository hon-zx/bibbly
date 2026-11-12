package app.bibbly.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.concurrent.thread

/** Microphone -> 16 kHz mono 16-bit PCM -> base64 "onFrames" events every 100 ms. */
class BibblyAudioModule : Module() {
  @Volatile private var running = false
  private var recorder: AudioRecord? = null
  private var worker: Thread? = null

  override fun definition() = ModuleDefinition {
    Name("BibblyAudio")
    Events("onFrames", "onError")

    AsyncFunction("start") { sampleRate: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NO_CONTEXT", "Bibbly is not ready yet.", null)
        return@AsyncFunction
      }
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("E_MIC_PERMISSION", "Microphone access is off for Bibbly. Turn it on in Settings.", null)
        return@AsyncFunction
      }
      try {
        startRecording(sampleRate)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("E_MIC_START", e.message ?: "The microphone could not start.", e)
      }
    }

    AsyncFunction("stop") {
      stopRecording()
    }

    Function("isRecording") {
      running
    }

    OnDestroy {
      stopRecording()
    }
  }

  @SuppressLint("MissingPermission") // checked in start()
  private fun startRecording(sampleRate: Int) {
    if (running) return
    val chunkBytes = sampleRate / 10 * 2 // 100 ms of 16-bit mono
    val minBuffer = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION, // tuned for speech, no call-style echo cancelling
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(minBuffer, chunkBytes * 4)
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException("The microphone is busy or unavailable.")
    }
    recorder = rec
    running = true
    rec.startRecording()
    worker = thread(name = "bibbly-mic") {
      val buffer = ByteArray(chunkBytes)
      while (running) {
        val n = rec.read(buffer, 0, buffer.size)
        if (n > 0) {
          sendEvent("onFrames", mapOf("pcm" to Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP), "sampleRate" to sampleRate))
        } else if (n < 0) {
          sendEvent("onError", mapOf("message" to "The microphone stopped working ($n)."))
          break
        }
      }
    }
  }

  private fun stopRecording() {
    running = false
    worker?.join(500)
    worker = null
    recorder?.let {
      try {
        it.stop()
      } catch (_: IllegalStateException) {
      }
      it.release()
    }
    recorder = null
  }
}
