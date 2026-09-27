import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as appsync from 'aws-cdk-lib/aws-appsync';
import { Construct } from 'constructs';

export interface ResultsSiteProps {
  api: appsync.GraphqlApi;
  /** Folder containing index.html. Uploaded as-is: no build step. */
  webDir: string;
}

/**
 * Section 4: static results page.
 *
 *   private S3 bucket ──(Origin Access Control)──▶ CloudFront ──HTTPS──▶ browser
 *
 * The page never contains the API URL or key. CDK writes them into config.json at deploy
 * time (Source.jsonData resolves CloudFormation tokens), and the page fetches that file.
 * So redeploying with a new key needs no code change, and nothing is hardcoded.
 */
export class ResultsSite extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ResultsSiteProps) {
    super(scope, id);

    const bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Brief: "tear it down" when asked → one `cdk destroy`, nothing left behind.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'PV4 results page',
    });

    new s3deploy.BucketDeployment(this, 'Deploy', {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.asset(props.webDir),
        s3deploy.Source.jsonData('config.json', {
          graphqlUrl: props.api.graphqlUrl,
          apiKey: props.api.apiKey,
        }),
      ],
      // The page is tiny and changes on every deploy; invalidate rather than fiddle with TTLs.
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    new CfnOutput(scope, 'ResultsPageUrl', { value: `https://${this.distribution.distributionDomainName}` });
  }
}
