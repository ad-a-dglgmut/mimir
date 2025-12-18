import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";

const version = process.env.APP_VERSION;
if (!version) throw new Error("APP_VERSION is not set");

const bucket = "mimir-updates";
const s3 = new S3Client({
    region: "eu-north-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Artifacts are downloaded into these subfolders by the workflow
const platformDirs = {
    linux: "./artifacts/linux-build",
    windows: "./artifacts/windows-build"
};

function detectPlatform(file) {
    // Tauri v2 Updater Targets
    if (file.endsWith(".AppImage.tar.gz")) return "linux-x86_64";
    if (file.endsWith(".msi.zip")) return "windows-x86_64";
    if (file.endsWith(".nsis.zip")) return "windows-x86_64";
    return null;
}

async function upload(file, key, contentType = "application/octet-stream") {
    console.log(`Uploading: ${file} -> ${key}`);
    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fs.readFileSync(file),
        ContentType: contentType
    }));
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
            console.log(`Directory ${dir} not found, skipping...`);
            continue;
        }

        // Recursively find all files in the artifact directory
        const allFiles = fs.readdirSync(dir, { recursive: true })
            .map(f => path.join(dir, f))
            .filter(f => fs.statSync(f).isFile());

        for (const file of allFiles) {
            const platform = detectPlatform(file);
            const sigFile = `${file}.sig`;

            // We only care about files that have a corresponding .sig file
            if (platform && fs.existsSync(sigFile)) {
                const fileName = path.basename(file);
                const key = `releases/${version}/${platform}/${fileName}`;
                const sigKey = `${key}.sig`;

                await upload(file, key);
                await upload(sigFile, sigKey, "text/plain");

                latest.platforms[platform] = {
                    url: `https://${bucket}.s3.eu-north-1.amazonaws.com/${key}`,
                    signature: fs.readFileSync(sigFile, "utf8").trim(),
                };
                console.log(`Added platform: ${platform}`);
            }
        }
    }

    const latestJson = JSON.stringify(latest, null, 2);
    console.log("Generated latest.json:", latestJson);

    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: "updates/latest.json",
        Body: latestJson,
        ContentType: "application/json",
    }));

    console.log("Successfully published latest.json to S3");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
