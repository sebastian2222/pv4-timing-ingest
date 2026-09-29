import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { Pv4Stack } from '../infra/pv4-stack';

let t: Template;

beforeAll(() => {
  const app = new App();
  const stack = new Pv4Stack(app, 'Pv4', {
    env: { account: '111111111111', region: 'ap-southeast-2' },
    alarmEmail: 'ops@example.com',
  });
  t = Template.fromStack(stack);
}, 120_000);

describe('data', () => {
  it('uses an on-demand table with pk/sk and a ttl', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('keeps rejected payloads for 30 days in a private bucket', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 30 })]) },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  it('deletes data resources with the stack', () => {
    const resources = t.toJSON().Resources as Record<string, { Type: string; DeletionPolicy?: string }>;
    for (const res of Object.values(resources)) {
      if (['AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::Logs::LogGroup'].includes(res.Type)) {
        expect(res.DeletionPolicy).toBe('Delete');
      }
    }
  });
});

describe('ingest', () => {
  it('runs the processor on Node 22 arm64 with the table and bucket names', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 512,
      Timeout: 10,
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          DEAD_LETTER_BUCKET: Match.anyValue(),
        }),
      },
    });
  });

  it('can write transactions and put rejected payloads', () => {
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('dynamodb:TransactWriteItems');
    expect(policies).toContain('s3:PutObject');
  });

  it('accepts only POST /timing, throttled at 200 per second', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /timing' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 },
    });
  });
});

describe('resolvers', () => {
  it('attaches four JS resolvers to the query fields', () => {
    const resolvers = Object.values(t.findResources('AWS::AppSync::Resolver')) as { Properties: Record<string, unknown> }[];
    expect(resolvers).toHaveLength(4);
    const fields = resolvers.map((r) => r.Properties.FieldName).sort();
    expect(fields).toEqual(['eventStats', 'events', 'results', 'updatesRejected']);
    for (const r of resolvers) {
      expect(r.Properties.TypeName).toBe('Query');
      expect(r.Properties.Runtime).toEqual({ Name: 'APPSYNC_JS', RuntimeVersion: '1.0.0' });
    }
  });
});

describe('outputs', () => {
  it('publishes the urls the submission email needs', () => {
    const names = Object.keys(t.findOutputs('*'));
    for (const id of ['IngestUrl', 'GraphqlUrl', 'GraphqlApiKey', 'ResultsPageUrl', 'DashboardUrl']) {
      expect(names.some((n) => n.includes(id))).toBe(true);
    }
  });
});
