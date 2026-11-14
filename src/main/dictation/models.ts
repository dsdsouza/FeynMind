import type { ModelSpec } from '../ingestion'
import type { SpeechModelId } from '../../shared/dictation'

// The speech models offered in Settings: OpenAI's English-only Whisper models (MIT), as ONNX exports
// by onnx-community (Apache-2.0), int8 quantized. Each is pinned to one commit; the ONNX files'
// SHA-256 come from Hugging Face's LFS records at that commit and the JSON files' were computed from
// the files at that commit on 2026-11-14. Every file is checked after download.

const TOKENIZER_FILES = [
  { path: 'tokenizer.json', size: 2405679, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' },
  { path: 'tokenizer_config.json', size: 282662, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c' }
]

export const SPEECH_MODELS: Record<SpeechModelId, ModelSpec> = {
  'tiny.en': {
    id: 'whisper-tiny.en-794207fe',
    name: 'Whisper tiny (English)',
    repo: 'onnx-community/whisper-tiny.en',
    revision: '794207fec2761281fe63a23a94b7e9f53a4efbc1',
    files: [
      { path: 'onnx/encoder_model_quantized.onnx', size: 10124993, sha256: 'e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 30718858, sha256: 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52' },
      { path: 'config.json', size: 2197, sha256: '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233' },
      { path: 'generation_config.json', size: 1646, sha256: '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9' },
      ...TOKENIZER_FILES
    ]
  },
  'base.en': {
    id: 'whisper-base.en-51eefc0a',
    name: 'Whisper base (English)',
    repo: 'onnx-community/whisper-base.en',
    revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
    files: [
      { path: 'onnx/encoder_model_quantized.onnx', size: 23201320, sha256: '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 53692803, sha256: 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909' },
      { path: 'config.json', size: 2197, sha256: 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1' },
      { path: 'generation_config.json', size: 1556, sha256: '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120' },
      ...TOKENIZER_FILES
    ]
  },
  'small.en': {
    id: 'whisper-small.en-482fb8ba',
    name: 'Whisper small (English)',
    repo: 'onnx-community/whisper-small.en',
    revision: '482fb8ba081b6e906f92efe103622316b2a0cc69',
    files: [
      { path: 'onnx/encoder_model_quantized.onnx', size: 92326170, sha256: 'dae677b93ca77f911d858238e277026fa8f95a94cb899ea443ec78ee62726edf' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 156750076, sha256: '29132c41903c252d0f2b9e59ee1e7d75f7d0b64d37f3e36d1ecc4a1a1af62953' },
      { path: 'config.json', size: 2203, sha256: '8825c4174cb86f94d9fa67614942f8aa17bfbbdf2fae5426d4adfd0bc5893c43' },
      { path: 'generation_config.json', size: 1956, sha256: '5490747ca976d6b3765280a0697d66489020c2afa6e754244d9cd093e1639331' },
      ...TOKENIZER_FILES
    ]
  }
}
