import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { FieldError } from './validate';

export interface RejectedRecord {
  raw: unknown;
  errors: FieldError[];
  requestId: string;
  receivedAt: string;
}

/** Returns the object key the payload was stored under. */
export interface DeadLetter {
  put(record: RejectedRecord): Promise<string>;
}

export class InMemoryDeadLetter implements DeadLetter {
  readonly records: RejectedRecord[] = [];

  async put(record: RejectedRecord): Promise<string> {
    this.records.push(record);
    const day = record.receivedAt.slice(0, 10);
    return `rejected/${day}/${record.requestId}.json`;
  }
}

/** Best-effort copy of a rejected payload. The counter is already committed before this runs. */
export class S3DeadLetter implements DeadLetter {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async put(record: RejectedRecord): Promise<string> {
    const day = record.receivedAt.slice(0, 10);
    const key = `rejected/${day}/${record.requestId}.json`;
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
    return key;
  }
}
