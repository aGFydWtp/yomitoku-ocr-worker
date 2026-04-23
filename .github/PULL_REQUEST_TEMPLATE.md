# Summary

<!-- 変更概要を 1〜3 行で。Why を中心に記載。 -->

## Related

<!-- Spec / Issue / Runbook へのリンク -->

- Spec: `.kiro/specs/<feature>/`
- Issue / Linear:

---

## Verification (CI グリーン確認)

ローカルおよび CI で以下が green であることを確認した:

- [ ] `pnpm test` が green (全 Jest スイート + pytest)
- [ ] `pnpm lint` が green (biome + `scripts/check-legacy-refs.sh`)
- [ ] `pnpm cdk synth --all` が green (全スタックの template 生成に成功)
- [ ] `pnpm cdk deploy --all` をステージング環境で green 実行済み、もしくは本 PR は synth のみで deploy 対象外

## SageMaker Async 移行エビデンス (該当する場合のみ)

Endpoint / Auto Scaling / Batch 実行層 / Monitoring / API いずれかを変更した PR は、
`docs/runbooks/sagemaker-async-cutover.md` の該当セクションを参照し、
運用影響を確認したうえで下記をチェックする:

- [ ] `docs/runbooks/sagemaker-async-cutover.md` の関連セクションを参照済み
  - 例: Step 1〜7 手順 / 503 運用 / 退避判定 / 月次コスト是正 / トラブルシュート
- [ ] ロールバック可否サマリ (Runbook 末尾) に照らし、本変更の可逆性を明記した
- [ ] 破壊的変更 (Endpoint / EndpointConfig / `BatchTable` / `ControlTable` 契約) を含む場合、
      Runbook の記載と整合する切替手順を別途提示済み

## Test Plan

<!-- 手動検証したシナリオを箇条書きで -->

- [ ]
- [ ]

## Notes

<!-- リリーサー / レビュアーへの申し送り事項があれば -->
