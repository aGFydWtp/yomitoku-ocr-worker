/**
 * CDK context から AWS region を解決するユーティリティ。
 *
 * 既定値は `ap-northeast-1`。Async Endpoint 用 `ml.g5.xlarge` が
 * アジアパシフィック (東京) で提供されており、周辺リソース (S3 / DynamoDB /
 * CloudFront オリジン) とのレイテンシ・データ所在・ガバナンス面で
 * 国内運用を想定する基本リージョンとして採用している。
 *
 * `-c region=us-east-1` は `ap-northeast-1` で `ml.g5.xlarge` の
 * capacity 逼迫が発生したときの退避用オプション。退避時は S3 バケット /
 * DynamoDB テーブル / Step Functions / CloudFront オリジンが
 * すべて `us-east-1` に新設される (region 間分離は CDK が保証) ため、
 * 既存 `ap-northeast-1` スタックとは独立した別環境として運用する必要がある。
 * 既存環境のデータは移行されない点に注意 (Task 8.1, Req 8.1/8.4)。
 */
export const DEFAULT_REGION = "ap-northeast-1";

export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/;

export interface RegionContextNode {
  tryGetContext(key: string): unknown;
}

/**
 * CDK `app.node` から region を解決する。未指定時は `DEFAULT_REGION`。
 * 形式不正 (`^[a-z]{2}-[a-z]+-\d$` に合致しない) な場合は Error を throw する。
 */
export function resolveRegionContext(node: RegionContextNode): string {
  const raw = node.tryGetContext("region") as string | undefined;
  const region = raw ?? DEFAULT_REGION;
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(`Invalid AWS region format: "${region}"`);
  }
  return region;
}
