import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { App, Stack, Duration } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { ResultsSite } from '../infra/results-site';
import { Observability } from '../infra/observability';
import { makeApi } from '../infra/api';
import { METRIC_NAMESPACE, OUTCOME_METRIC } from '../src/obs';

const root = join(import.meta.dirname, '..');
let t: Template;

beforeAll(() => {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: '111111111111', region: 'ap-southeast-2' } });
  const logGroup = new logs.LogGroup(stack, 'ProcessorLogs', { retention: logs.RetentionDays.ONE_WEEK });
  const processor = new lambda.Function(stack, 'Processor', {
    runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'), logGroup, timeout: Duration.seconds(10),
  });
  const api = makeApi(stack, join(root, 'schema.graphql'));
  new ResultsSite(stack, 'Site', { api, webDir: join(root, 'web') });
  new Observability(stack, 'Obs', { processor, logGroup, alarmEmail: 'ops@example.com' });
  t = Template.fromStack(stack);
});

describe('section 4 — results page on S3 behind CloudFront', () => {
  it('bucket is private — only CloudFront can read it', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('CloudFront serves index.html over HTTPS', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  it('deploys the page plus a generated config.json, and invalidates the cache', () => {
    t.hasResourceProperties('Custom::CDKBucketDeployment', { DistributionPaths: ['/*'] });
  });

  it('config.json is built from the real API URL and key (nothing hardcoded)', () => {
    const dep = Object.values(t.findResources('Custom::CDKBucketDeployment'))[0] as { Properties: { SourceMarkers: unknown } };
    const markers = JSON.stringify(dep.Properties.SourceMarkers);
    expect(markers).toMatch(/GraphQLUrl/);
    expect(markers).toMatch(/ApiKey/);
  });

  it('outputs the CloudFront URL for the submission', () => {
    expect(Object.keys(t.findOutputs('*')).some((k) => k.includes('ResultsPageUrl'))).toBe(true);
  });
});

describe('AppSync API key — must outlive the review period', () => {
  it('expires ~360 days out, not the 7-day default', () => {
    const key = Object.values(t.findResources('AWS::AppSync::ApiKey'))[0] as { Properties: { Expires: number } };
    const days = (key.Properties.Expires * 1000 - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(300);
    expect(days).toBeLessThanOrEqual(365);
  });
});

describe('section 5 — custom metric + alarms', () => {
  it('rejection-rate alarm uses the exact metric names the processor emits', () => {
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as { Properties: Record<string, any> }[];
    const rate = alarms.find((a) => (a.Properties.Metrics ?? []).some((m: any) => m.Expression));
    expect(rate, 'a metric-math alarm exists').toBeDefined();
    const used = rate!.Properties.Metrics.filter((m: any) => m.MetricStat).map((m: any) => m.MetricStat.Metric);
    for (const m of used) expect(m.Namespace).toBe(METRIC_NAMESPACE);
    expect(used.map((m: any) => m.MetricName).sort()).toEqual(Object.values(OUTCOME_METRIC).sort());
  });

  it('rejection-rate alarm sits above the ~10% baseline and ignores tiny samples', () => {
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as { Properties: Record<string, any> }[];
    const rate = alarms.find((a) => (a.Properties.Metrics ?? []).some((m: any) => m.Expression))!;
    expect(rate.Properties.Threshold).toBeGreaterThanOrEqual(20);
    const expr = rate.Properties.Metrics.find((m: any) => m.Expression).Expression as string;
    expect(expr).toMatch(/>=\s*20/);
    expect(rate.Properties.TreatMissingData).toBe('notBreaching');
  });

  it('processor-errors alarm fires on a single crash', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors', Namespace: 'AWS/Lambda', Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  it('alarms notify an SNS topic with an email subscription', () => {
    t.resourceCountIs('AWS::SNS::Topic', 1);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as { Properties: Record<string, any> }[];
    for (const a of alarms) expect(a.Properties.AlarmActions).toHaveLength(1);
  });
});

describe('section 5 — showing it: saved queries + dashboard', () => {
  it('saves a Logs Insights query that traces one bib end to end', () => {
    t.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: Match.stringLikeRegexp('Trace a bib'),
      QueryString: Match.stringLikeRegexp('filter bib = '),
    });
  });

  it('saves a query for rejected updates', () => {
    t.hasResourceProperties('AWS::Logs::QueryDefinition', {
      QueryString: Match.stringLikeRegexp('outcome = "REJECTED"'),
    });
  });

  it('creates a dashboard and outputs its URL', () => {
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    expect(Object.keys(t.findOutputs('*')).some((k) => k.includes('DashboardUrl'))).toBe(true);
  });

  it('alarms when the processor gives up or sees two truths for one revision', () => {
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as { Properties: Record<string, unknown> }[];
    for (const [name, metric] of [['pv4-processing-failures', 'ProcessingFailures'], ['pv4-conflicting-revision', 'ConflictingRevision']] as const) {
      const alarm = alarms.find((a) => a.Properties.AlarmName === name);
      expect(alarm, name).toBeDefined();
      const body = JSON.stringify(alarm);
      expect(body).toContain(metric);
      expect(body).toContain(METRIC_NAMESPACE);
    }
  });
});
