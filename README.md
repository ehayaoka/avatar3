# しゃべるキャラクター（Web版）

台本を入力すると、ブラウザの標準音声で読み上げ、キャラクターの表情と口が動きます。
5感情（通常・喜び・怒り・困り・驚き）× 口2段階（閉・開）＝ 10枚の画像を、各自のブラウザからアップロードして使います。

- 画像・台本は、そのパソコンのブラウザの中（IndexedDB / localStorage）だけに保存され、サーバーには送られません。
- サーバーはファイルを配るだけなので、15人が同時に使っても負荷はほぼかかりません。
- 推奨ブラウザ：Chrome・Edge・Safari（パソコン）。Firefox は行の終わりに雑音が入ることがあるため非推奨。

## 公開方法A：さくらのレンタルサーバ
1. このフォルダの中身を、`www/wayo/la/talk/` などの **新しいフォルダ** にアップロードします
   （`/wayo/la/` 直下には既に別のアプリの `index.html` があるので、上書きしないこと）。
2. 学生には `https://ehayaoka.sakura.ne.jp/wayo/la/talk/` を案内します。

## 公開方法B：GitHub Pages
1. GitHub で新しいリポジトリ（例：`chara-talk`）を作り、このフォルダの中身をアップロード（Add file → Upload files）。
2. Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `(root)` にして Save。
3. 数分後に `https://<ユーザー名>.github.io/chara-talk/` で開けます。
   ※ 無料プランでは公開リポジトリになり、`samples/` の画像も公開されます。不要なら `samples/` を削除してください。

## ファイル構成
- `index.html` 操作画面 / `stage.html` 出力画面（1920×1080、ATEMへ）
- `js/common.js` 感情の定義・画像保存 / `js/control.js` 操作画面 / `js/stage.js` 出力画面
- `samples/majo/` 「サンプル」ボタンで読み込む画像（任意）
- `学生向け_使い方.txt` 配布用の説明
