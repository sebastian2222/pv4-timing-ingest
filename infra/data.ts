import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** The single table and the bucket that keeps rejected payloads for 30 days. */
export class Data extends Construct {
  readonly table: dynamodb.Table;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: 'pv4',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      // On-demand: a small provisioned table would throttle the harness burst.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Only the delivery marker sets `ttl`. Athlete rows have no ttl, so they stay.
      timeToLiveAttribute: 'ttl',
      // The assessment stack is torn down after review. DESTROY removes the table with it.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.bucket = new s3.Bucket(this, 'DeadLetter', {
      // Rejected bodies can contain anything the venue sent. The bucket is not public.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Long enough to inspect a bad payload after the race, then it expires.
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
