#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib/core";
import { AwsSolutionsChecks } from "cdk-nag";

const app = new App();

// context values validated at stack creation (see cdk.context.json.example)
// Stacks are added per phase (see YomiToku-Pro_タスク一覧.md フェーズ 1-5)

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
