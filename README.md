# Wine Menu（店舗用メニュー）

店舗のiPadでURLを開くだけで表示できる、ワイン・シャンパーニュ・ブランデー用のメニューです。日本語・英語・中国語に切り替えられます。本部のPCから、パスワード付きの管理画面で全店舗のメニューを更新します。

- 公開とデータ保存には Cloudflare Pages と D1 を使います。どちらも無料プランで、カード登録は不要です。
- 写真はPCのブラウザで1枚100〜250KBに圧縮してから保存します。

## 画面

| 用途 | URL |
|---|---|
| 管理画面（PC） | `https://<プロジェクト名>.pages.dev/#admin` |
| 店舗ごとのお客様画面（iPad） | `https://<プロジェクト名>.pages.dev/#menu-<店舗ID>`（管理画面の「店舗の管理」に表示されます） |

## Cloudflareでの初回設定（1回だけ）

1. Cloudflareのダッシュボードで **Storage & Databases → D1 → Create database** を開き、名前を `wine-menu-db` にして作成します。
2. **Workers & Pages → Create → Pages → Connect to Git** を開き、GitHubの `wine-menu` リポジトリを選びます。
   - Framework preset：`None`
   - Build command：空欄
   - Build output directory：空欄（そのまま）
3. 作成したPagesプロジェクトの **Settings → Bindings → Add → D1 database** を開き、Variable name を `DB`、Database を `wine-menu-db` にします。
4. **Settings → Variables and Secrets → Add** を開き、Type を `Secret`、Name を `ADMIN_PASSWORD` にして、Value に管理用パスワードを入れます。
5. **Deployments** から最新のデプロイを選び、「Retry deployment」で再デプロイします。

表は初回アクセス時に自動で作られます。

## 無料枠の目安（Cloudflare 無料プラン）

- D1：保存容量5GB、1日500万行の読み取り
- Pages Functions：1日10万リクエスト
- 写真が1枚150KBなら、数万枚まで保存できます。写真は1年間ブラウザにキャッシュされるため、2回目以降の表示ではほとんど通信しません。
- iPadは3分ごとに更新の有無だけを確認し、変更があったときだけメニューを読み直します。
