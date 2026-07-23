# Drive AIFF Player — Google Drive「アプリで開く」版

Google DriveでAIFFを右クリックし、

アプリで開く → Drive AIFF Player

でブラウザ再生するための小さな静的Webアプリです。

## 重要
Google Drive公式の「アプリで開く」連携では Open URL に
- 完全修飾ドメイン名が必要
- localhost は不可
- chrome-extension:// もOpen URLとしては使えない

ため、このフォルダを HTTPS のWebホスティングに一度だけ配置します。

## アプリの処理
1. Google Driveが Open URL に `?state=...` を付ける
2. `state.ids[0]` から選択されたDrive file IDを取得
3. Google OAuthで drive.readonly / drive.install を許可
4. Drive API files.get でメタデータとAIFF本体を取得
5. AIFF PCMをブラウザ内でWAV PCMへ変換
6. audio要素で再生

ファイル自体をWAVとして保存したり、Driveを書き換えたりはしません。

## 対応
- AIFF（非圧縮PCM）
- 8 / 16 / 24 / 32 bit
- resourceKey付きファイル
- Shared Drive用 supportsAllDrives

## 未対応
- AIFC（圧縮AIFF）
- 複数選択時は最初の1ファイルのみ

## 配置後に必要なGoogle Cloud設定

### 1. OAuth「ウェブ アプリケーション」クライアントを作る
既に作成したChrome拡張機能用OAuth Client IDとは別です。

承認済みJavaScript生成元:
    https://YOUR-HOST.example

発行されたClient IDを `config.js` に入れます。

### 2. Drive UI integration
Google Cloud Console:
Google Drive API → Drive UI integration

設定例:
- Application name: Drive AIFF Player
- Open URL: https://YOUR-HOST.example/
- Default file extensions:
    aif,aiff
- Default MIME types（必要に応じて）:
    audio/aiff,audio/x-aiff
- 「Open with」を使用する設定を有効化
- Submit

Driveの公式ドキュメントでは「Open with」に表示するアプリは
`https://www.googleapis.com/auth/drive.install` scopeを要求するよう案内されています。
このアプリはそのscopeも要求します。

## ホスティング
このフォルダは静的ファイルだけなので、
GitHub Pages / Cloudflare Pages / Netlify / 自分のWebサーバーなどで配信できます。
