#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { Pv4Stack } from '../infra/pv4-stack';

const app = new App();
const alarmEmail = app.node.tryGetContext('alarmEmail');

new Pv4Stack(app, 'Pv4Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-southeast-2',
  },
  alarmEmail: typeof alarmEmail === 'string' ? alarmEmail : undefined,
  description: 'PV4 timing ingest and results',
});
