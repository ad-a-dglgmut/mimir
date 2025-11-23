import fs from "fs";
import path from "path";
import AWS from "aws-sdk";

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "eu-north-1", // change if needed
});

const version = process.env.GITHUB_REF.replace("refs/tags/", "");
const bucket = "mimir-updates";
const distDir = path.resolve("./src-tauri/target/release/bundle"); // Tauri build output

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
  const key = path.relative(distDir, filePath).replace(/\\/g, "/"); // normalize windows paths
  await s3
    .upload({
      Bucket: bucket,
      Key: key,
      Body: fileContent,
      ACL: "public-read",
    })
    .promise();
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
  await uploadFile(path.resolve("latest.json"));

  console.log("latest.json updated and uploaded!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
