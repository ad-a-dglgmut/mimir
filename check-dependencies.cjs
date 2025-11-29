const { execSync } = require('child_process');

function checkCommand(cmd, name) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    console.log(`${name} is installed ✅`);
  } catch (err) {
    console.error(`ERROR: ${name} is not installed!`);
    process.exit(1);
  }
}

// Check Node.js
checkCommand('node -v', 'Node.js');

// Check Rust
checkCommand('cargo -V', 'Rust');

// Check Python
checkCommand('python3 --version || python --version', 'Python');

// Optional: Check required Python packages
const requiredPackages = ['pandas', 'numpy', 'matplotlib', 'groq'];
try {
  const missingPackages = requiredPackages.filter(pkg => {
    try {
      execSync(`python3 -c "import ${pkg}"`, { stdio: 'ignore' });
      return false;
    } catch {
      try {
        execSync(`python -c "import ${pkg}"`, { stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    }
  });

  if (missingPackages.length > 0) {
    console.error(`ERROR: Missing Python packages: ${missingPackages.join(', ')}`);
    process.exit(1);
  }

  console.log('All required Python packages are installed ✅');
} catch (err) {
  console.error(err);
  process.exit(1);
}

