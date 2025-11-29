import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const s3 = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const version = process.env.GITHUB_REF.replace("refs/tags/", "");
const bucket = "mimir-updates";

// Platform-specific build directories
const platformDirs = {
  'linux': path.resolve("./dist/linux"),
  'windows': path.resolve("./dist/windows"),
  'macos': path.resolve("./dist/macos")
};

// Helper to recursively find files
function getBuildFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  
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

// Filter only update-related files and find corresponding signatures
function getUpdateFilesWithSignatures(dir) {
  const files = getBuildFiles(dir);
  const updateFiles = [];
  
  files.forEach(file => {
    const filename = path.basename(file).toLowerCase();
    
    // Look for update bundles (tar.gz, zip) and their signatures
    if (filename.endsWith('.tar.gz') || filename.endsWith('.zip') || filename.endsWith('.sig')) {
      const baseName = path.basename(file);
      const isSignature = baseName.endsWith('.sig');
      const baseFile = isSignature ? file.replace('.sig', '') : file;
      
      // Check if we already have this file in our list
      const existingFile = updateFiles.find(f => f.filePath === baseFile);
      
      if (isSignature) {
        if (existingFile) {
          existingFile.signaturePath = file;
        } else {
          updateFiles.push({
            filePath: baseFile,
            signaturePath: file,
            fileName: path.basename(baseFile)
          });
        }
      } else {
        if (!existingFile) {
          updateFiles.push({
            filePath: file,
            signaturePath: file + '.sig',
            fileName: path.basename(file)
          });
        }
      }
    }
  });
  
  return updateFiles;
}

// Upload file to S3
async function uploadFileToS3(filePath, key) {
  const fileContent = fs.readFileSync(filePath);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileContent,
  });
  
  await s3.send(command);
  return key;
}

// Upload directory recursively to S3
async function uploadDirectoryToS3(localPath, s3Prefix) {
  const files = getBuildFiles(localPath);
  
  for (const file of files) {
    const relativePath = path.relative(localPath, file);
    const s3Key = path.join(s3Prefix, relativePath).replace(/\\/g, '/');
    
    await uploadFileToS3(file, s3Key);
    console.log(`  Uploaded: ${s3Key}`);
  }
}

// Read signature from .sig file
function readSignature(signaturePath) {
  if (fs.existsSync(signaturePath)) {
    const signatureContent = fs.readFileSync(signaturePath, 'utf8').trim();
    console.log(`Found signature at ${signaturePath}: ${signatureContent.substring(0, 50)}...`);
    return signatureContent;
  }
  console.warn(`No signature file found at ${signaturePath}`);
  return "";
}

// Determine platform from file characteristics
function determinePlatformFromFile(filePath, fileName) {
  if (filePath.includes('/linux/') || fileName.includes('linux')) {
    return 'linux-x86_64';
  }
  if (filePath.includes('/windows/') || fileName.includes('windows')) {
    return 'windows-x86_64';
  }
  if (filePath.includes('/macos/') || fileName.includes('darwin') || fileName.includes('macos') || fileName.includes('.app.')) {
    return 'darwin-x86_64';
  }
  
  return null;
}

async function main() {
  const latestJson = {
    version,
    notes: "Automatic update",
    pub_date: new Date().toISOString(),
    platforms: {}
  };

  // Process each platform
  for (const [platformName, platformDir] of Object.entries(platformDirs)) {
    if (!fs.existsSync(platformDir)) {
      console.log(`No build files found for ${platformName}`);
      continue;
    }

    console.log(`\nProcessing ${platformName} files from ${platformDir}`);
    
    const updateFiles = getUpdateFilesWithSignatures(platformDir);
    console.log(`Found ${updateFiles.length} update files for ${platformName}`);

    for (const fileInfo of updateFiles) {
      console.log(`Processing: ${fileInfo.fileName}`);
      console.log(`  File: ${fileInfo.filePath}`);
      console.log(`  Signature: ${fileInfo.signaturePath}`);
      
      // Upload the main file
      const fileKey = `releases/${version}/${platformName}/${path.basename(fileInfo.filePath)}`;
      await uploadFileToS3(fileInfo.filePath, fileKey);
      console.log(`  Uploaded to: ${fileKey}`);
      
      // Upload the signature file if it exists
      if (fs.existsSync(fileInfo.signaturePath)) {
        const sigKey = `releases/${version}/${platformName}/${path.basename(fileInfo.signaturePath)}`;
        await uploadFileToS3(fileInfo.signaturePath, sigKey);
        console.log(`  Signature uploaded to: ${sigKey}`);
      }
      
      // Add to latest.json
      const platform = determinePlatformFromFile(fileInfo.filePath, fileInfo.fileName);
      if (platform) {
        const signature = readSignature(fileInfo.signaturePath);
        latestJson.platforms[platform] = {
          signature: signature,
          url: `https://${bucket}.s3.eu-north-1.amazonaws.com/${fileKey}`
        };
        console.log(`  Added to latest.json for platform: ${platform}`);
      }
    }

    // Upload Python virtual environments for this platform
    console.log(`\nUploading Python virtual environment for ${platformName}...`);
    const venvPath = path.join(platformDir, 'python');
    if (fs.existsSync(venvPath)) {
      await uploadDirectoryToS3(venvPath, `releases/${version}/${platformName}/python`);
    } else {
      console.log(`  No Python virtual environment found at ${venvPath}`);
    }
  }

  // Validate that we have all required platforms
  const requiredPlatforms = ['linux-x86_64', 'darwin-x86_64', 'windows-x86_64'];
  for (const platform of requiredPlatforms) {
    if (!latestJson.platforms[platform]) {
      console.warn(`Missing platform ${platform} in latest.json`);
    }
  }

  // Save and upload latest.json
  fs.writeFileSync("latest.json", JSON.stringify(latestJson, null, 2));
  
  const latestJsonCommand = new PutObjectCommand({
    Bucket: bucket,
    Key: "updates/latest.json",
    Body: JSON.stringify(latestJson, null, 2),
    ContentType: "application/json",
  });
  await s3.send(latestJsonCommand);

  console.log("\nMulti-platform update artifacts uploaded!");
  console.log("latest.json content:", JSON.stringify(latestJson, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
