# あ箱 Local Player v3

現行 Public Player をそのままローカル `.scene` 再生に使う Local Player。

## v3
- 表紙・再生中・読了のどこからでも左上「‹ 選択」で入口へ戻れる
- 戻る時に現行 Public Player/Core を正式に破棄
- 再生中の音声を停止
- ローカル package の Blob URL を解放
- Scene / RESONANCE のセッション状態を初期化
- ページリロード不要で別の `.scene` を選択可能

本棚・作品保存機能は未実装。ファイル選択は毎回端末の Files / ファイルピッカーから行う。
