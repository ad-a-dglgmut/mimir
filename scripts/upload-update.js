import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";

const s3 = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const version = process.env.GITHUB_REF.replace("refs/tags/", "");
const bucket = "mimir-updates";
const distDir = path.resolve("./src-tauri/target/release/bundle");

// Helper to recursively find files in bundle folder
function getBuildFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getBuildFiles(filePath));
    } else {
      results.push(filePath);
    }
  });
  return results;
}

// Upload each build file to S3
async function uploadFile(filePath) {
  const fileContent = fs.readFileSync(filePath);
  const key = path.relative(distDir, filePath).replace(/\\/g, "/");
  
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileContent,
    ACL: "public-read",
  });
  
  await s3.send(command);
  return key;
}

async function main() {
  const files = getBuildFiles(distDir);
  console.log("Found build files:", files);

  const uploadedFiles = [];
  for (const file of files) {
    const key = await uploadFile(file);
    uploadedFiles.push(key);
  }

  // Build the latest.json dynamically
  const latestJson = {
    version,
    files: uploadedFiles.map((f) => ({
      url: `https://${bucket}.s3.eu-north-1.amazonaws.com/${f}`,
      name: path.basename(f),
      size: fs.statSync(path.join(distDir, f)).size,
    })),
  };

  fs.writeFileSync("latest.json", JSON.stringify(latestJson, null, 2));
  
  // Upload latest.json
  const latestJsonContent = JSON.stringify(latestJson, null, 2);
  const latestJsonCommand = new PutObjectCommand({
    Bucket: bucket,
    Key: "latest.json",
    Body: latestJsonContent,
    ContentType: "application/json",
    ACL: "public-read",
  });
  await s3.send(latestJsonCommand);

  console.log("latest.json updated and uploaded!");
  console.log("Uploaded files:", uploadedFiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
