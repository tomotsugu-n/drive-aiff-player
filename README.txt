AIFF Player for Google Drive™ — Final Blue v2

修正:
- Drive API v3 に存在しない audioMediaMetadata の要求を削除
- files.get は id/name/mimeType/size/capabilities(canDownload) のみ取得
- 44.1 kHz / 16-bit / Stereo 等はAIFF自身のCOMMチャンクから取得
- OAuthは前版の「再生ボタンクリック起点」のまま
- MIME診断等の開発UIは無し
- アクセントカラー #2A7FCC

GitHubで差し替える:
- app.js
（index.html / style.css は前のBlue版と同一ですが、ZIPには同梱しています）

config.js は変更しないでください。

Google Drive™ is a trademark of Google LLC.
