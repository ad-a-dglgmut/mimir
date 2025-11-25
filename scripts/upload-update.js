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

// Filter only update-related files (exclude installers)
function getUpdateFiles(dir) {
  const files = getBuildFiles(dir);
  return files.filter(file => {
    const filename = path.basename(file).toLowerCase();
    // Exclude installer files, keep update artifacts
    return !filename.endsWith('.deb') && 
           !filename.endsWith('.rpm') && 
           !filename.endsWith('.appimage') &&
           !filename.endsWith('.msi') &&
           !filename.endsWith('.exe') &&
           !filename.endsWith('.dmg') &&
           !filename.endsWith('.pkg');
  });
}

// Upload update files to S3 in updates/ folder
async function uploadUpdateFile(filePath, platform) {
  const fileContent = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const key = `updates/${platform}/${filename}`;
  
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileContent,
  });
  
  await s3.send(command);
  return key;
}

// Determine platform from file characteristics
function determinePlatformFromFile(filePath) {
  const filename = path.basename(filePath).toLowerCase();
  
  if (filename.includes('linux') || filename.includes('appimage')) {
    return 'linux-x86_64';
  }
  if (filename.includes('windows') || filename.includes('msi') || filename.includes('exe') || filename.includes('nsis')) {
    return 'windows-x86_64';
  }
  if (filename.includes('macos') || filename.includes('darwin') || filename.includes('dmg') || filename.includes('app')) {
    return 'darwin-x86_64';
  }
  
  // Fallback based on directory structure
  if (filePath.includes('/linux/')) return 'linux-x86_64';
  if (filePath.includes('/windows/')) return 'windows-x86_64';
  if (filePath.includes('/macos/')) return 'darwin-x86_64';
  
  return null;
}

async function main() {
  const allUpdateFiles = [];
  const platformFiles = {};

  // Process each platform
  for (const [platformName, platformDir] of Object.entries(platformDirs)) {
    if (!fs.existsSync(platformDir)) {
      console.log(`No build files found for ${platformName}`);
      continue;
    }

    const updateFiles = getUpdateFiles(platformDir);
    console.log(`Found ${updateFiles.length} update files for ${platformName}:`, updateFiles);

    const uploadedFiles = [];
    for (const file of updateFiles) {
      const key = await uploadUpdateFile(file, platformName);
      uploadedFiles.push(key);
      allUpdateFiles.push(key);
    }

    platformFiles[platformName] = uploadedFiles;
  }

  // Build the latest.json for the updater
  const latestJson = {
    version,
    notes: "Automatic update",
    pub_date: new Date().toISOString(),
    platforms: {}
  };

  // Add platform entries for update files
  for (const file of allUpdateFiles) {
    const platform = determinePlatformFromFile(file);
    if (platform && file.includes('.tar.') || file.includes('.zip') || file.includes('.sig')) {
      // This is likely an update bundle or signature
      const baseName = path.basename(file);
      if (baseName.endsWith('.sig')) {
        // This is a signature file, associate it with the main file
        continue;
      }
      
      latestJson.platforms[platform] = {
        signature: "", // You'll need to add actual signature logic
        url: `https://${bucket}.s3.eu-north-1.amazonaws.com/${file}`
      };
    }
  }

  // If no update bundles found, create placeholder structure
  if (Object.keys(latestJson.platforms).length === 0) {
    console.log("No update bundles found. Creating placeholder structure.");
    latestJson.platforms = {
      "linux-x86_64": {
        signature: "",
        url: `https://${bucket}.s3.eu-north-1.amazonaws.com/updates/linux/placeholder.tar.gz`
      },
      "windows-x86_64": {
        signature: "",
        url: `https://${bucket}.s3.eu-north-1.amazonaws.com/updates/windows/placeholder.zip`
      },
      "darwin-x86_64": {
        signature: "",
        url: `https://${bucket}.s3.eu-north-1.amazonaws.com/updates/macos/placeholder.tar.gz`
      }
    };
  }

  fs.writeFileSync("latest.json", JSON.stringify(latestJson, null, 2));
  
  // Upload latest.json to updates/ folder
  const latestJsonContent = JSON.stringify(latestJson, null, 2);
  const latestJsonCommand = new PutObjectCommand({
    Bucket: bucket,
    Key: "updates/latest.json",
    Body: latestJsonContent,
    ContentType: "application/json",
  });
  await s3.send(latestJsonCommand);

  console.log("Multi-platform update artifacts uploaded!");
  console.log("Uploaded files:", allUpdateFiles);
  console.log("latest.json content:", latestJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
