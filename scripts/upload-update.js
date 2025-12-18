import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";

const version = process.env.APP_VERSION;
if (!version) {
  throw new Error("APP_VERSION is not set");
}

const bucket = "mimir-updates";
const region = "eu-north-1";

const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * These MUST match actions/download-artifact output
 */
const platformDirs = {
  linux: "artifacts/linux-build",
  windows: "artifacts/windows-build",
  // macos: "artifacts/macos-build", // enable when you build macOS
};

function findFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map(f => path.join(dir, f))
    .filter(f => fs.statSync(f).isFile());
}

function detectPlatform(file) {
  if (file.endsWith(".AppImage")) return "linux-x86_64";
  if (file.endsWith(".msi")) return "windows-x86_64";
  if (file.endsWith(".app.tar.gz")) return "darwin-x86_64";
  return null;
}

async function upload(file, key) {
  console.log("Uploading:", key);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.readFileSync(file),
    })
  );
}

async function main() {
  const latest = {
    version,
    notes: `Release ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {},
  };

  for (const [name, dir] of Object.entries(platformDirs)) {
    if (!fs.existsSync(dir)) {
      console.warn("Skipping missing dir:", dir);
      continue;
    }

    const files = findFiles(dir).filter(
      f =>
        f.endsWith(".AppImage") ||
        f.endsWith(".msi") ||
        f.endsWith(".app.tar.gz")
    );

    for (const file of files) {
      const sig = `${file}.sig`;
      if (!fs.existsSync(sig)) {
        console.warn("Missing signature:", sig);
        continue;
      }

      const platform = detectPlatform(file);
      if (!platform) continue;

      const key = `releases/${version}/${name}/${path.basename(file)}`;
      const sigKey = `${key}.sig`;

      await upload(file, key);
      await upload(sig, sigKey);

      latest.platforms[platform] = {
        url: `https://${bucket}.s3.${region}.amazonaws.com/${key}`,
        signature: fs.readFileSync(sig, "utf8").trim(),
      };
    }
  }

  if (Object.keys(latest.platforms).length === 0) {
    throw new Error("No platforms found — artifacts not detected");
  }

  const json = JSON.stringify(latest, null, 2);

  fs.writeFileSync("latest.json", json);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "updates/latest.json",
      Body: json,
      ContentType: "application/json",
    })
  );

  console.log("✅ latest.json published");
  console.log("Version:", version);
}

main().catch(err => {
  console.error("❌ Upload failed");
  console.error(err);
  process.exit(1);
});
