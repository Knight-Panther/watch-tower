import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string; // e.g. "https://pub-xxxx.r2.dev" or custom domain
}

export function createR2Storage(config: R2Config) {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    /** Upload image buffer to R2, returns public URL */
    async uploadImage(buffer: Buffer, key: string, contentType = "image/webp"): Promise<string> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000", // 1 year (immutable content-addressed)
        }),
      );
      return `${config.publicUrl}/${key}`;
    },

    /** Delete a single image from R2 by key */
    async deleteImage(key: string): Promise<void> {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucketName,
          Key: key,
        }),
      );
    },

    /** Delete multiple images from R2 (batch, max 1000 per call) */
    async deleteImages(keys: string[]): Promise<void> {
      if (keys.length === 0) return;

      // R2 supports up to 1000 objects per batch delete
      const batches: string[][] = [];
      for (let i = 0; i < keys.length; i += 1000) {
        batches.push(keys.slice(i, i + 1000));
      }

      for (const batch of batches) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: config.bucketName,
            Delete: {
              Objects: batch.map((key) => ({ Key: key })),
              Quiet: true,
            },
          }),
        );
      }
    },

    /** Construct public URL for a key */
    getPublicUrl(key: string): string {
      return `${config.publicUrl}/${key}`;
    },
  };
}

export type R2Storage = ReturnType<typeof createR2Storage>;
