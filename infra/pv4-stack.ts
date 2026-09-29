import { Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { join } from 'node:path';
import { makeApi } from './api';
import { Data } from './data';
import { Ingest } from './ingest';
import { Observability } from './observability';
import { addResolvers } from './resolvers';
import { ResultsSite } from './results-site';

export interface Pv4StackProps extends StackProps {
  alarmEmail?: string;
}

export class Pv4Stack extends Stack {
  constructor(scope: Construct, id: string, props: Pv4StackProps = {}) {
    super(scope, id, props);
    const root = join(import.meta.dirname, '..');
    // Table first, then the writer, then the reader, then the page and the alarms.
    const data = new Data(this, 'Data');
    const ingest = new Ingest(this, 'Ingest', { table: data.table, bucket: data.bucket });
    const api = makeApi(this, join(root, 'schema.graphql'));
    addResolvers(this, api, data.table);
    new ResultsSite(this, 'Site', { api, webDir: join(root, 'web') });
    new Observability(this, 'Obs', {
      processor: ingest.fn,
      logGroup: ingest.logGroup,
      alarmEmail: props.alarmEmail,
    });
  }
}
