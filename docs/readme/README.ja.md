# Servare

[![CI](https://github.com/dk-1ng/servare/actions/workflows/ci.yml/badge.svg)](https://github.com/dk-1ng/servare/actions/workflows/ci.yml)

[English](../../README.md) · [Português (BR)](README.pt-BR.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · **日本語**

> これは翻訳です。内容に相違がある場合は[英語版](../../README.md)が優先されます。

ページが読み込む動画・音声を検出し、ローカルに保存できる Firefox / Chromium 用の拡張機能です。直接ファイル、HLS、DASH に対応し、すべての処理はブラウザ内で行われます。

> **ステータス:** 開発中（プレアルファ）。進捗は[プロジェクトボード](https://github.com/users/dk-1ng/projects/4)と [milestones](https://github.com/dk-1ng/servare/milestones) で確認できます。

## 予定している機能

- ページのネットワークリクエストを監視してメディアを自動検出
- 直接ファイル（MP4、WebM、MKV、MP3…）、HLS、DASH
- 画質・音声トラック・字幕の選択
- ライブ配信の録画（HLS）
- 音声を MP3 として抽出
- 一時停止・再開に対応したキュー（ブラウザ再起動後も再開可能）
- WebAssembly 版 FFmpeg によるローカルでのリマックス — ネイティブアプリ・サーバー・テレメトリーなし
- ミラーモード（Firefox）: プレーヤーが既に取得したデータを再利用し、追加のリクエストを発生させない

## 対象外

- **YouTube** — 設計方針としてサポートしません。
- **DRM で保護されたコンテンツ**（Widevine、PlayReady、FairPlay など）— 検出したうえでダウンロードを拒否します。Servare は DRM、ログイン、ペイウォール、その他の技術的保護手段を回避するコードを含まず、今後も受け入れません。

## 開発

必要なもの: Node.js LTS、pnpm、FFmpeg（テスト用フィクスチャの生成に使用）。

```sh
pnpm install
pnpm dev            # Chromium（ライブリロード）
pnpm dev:firefox    # Firefox
pnpm test           # ユニットテスト
pnpm build          # 両ブラウザ向けの本番パッケージ
```

技術ドキュメント（英語）: [docs/design.md](../design.md)。コントリビュート方法: [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 法的通知

Servare は、ブラウザが既に受信しているメディアを保存するための汎用ツールです。**本ツールの利用に関する責任はすべて利用者にあります。** ダウンロードする権利のあるコンテンツ（自作のもの、フリーライセンスのもの、パブリックドメインのもの、権利者の許可を得たもの）のみをダウンロードし、お住まいの国の著作権法および各サイトの利用規約を遵守してください。

本プロジェクトは、いかなるウェブサイト、ストリーミングサービス、他の拡張機能とも提携しておらず、それらから支援や承認を受けていません。第三者の名称および商標は各所有者に帰属します。

本ソフトウェアは [MIT ライセンス](../../LICENSE)のもと「現状のまま」提供され、いかなる保証もありません。

## ライセンス

[MIT](../../LICENSE)。サードパーティ製コンポーネント（LGPL-2.1 の libav.js/FFmpeg や LAME など）はそれぞれのライセンスに従います。一覧は `THIRD_PARTY_NOTICES.md` にあります。
