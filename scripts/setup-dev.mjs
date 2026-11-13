#!/usr/bin/env node
/**
 * 🛠️ VerityDAM - One-Command Local Development Bootstrap for Developers
 *
 * Runs all onboarding steps in sequence:
 * 1. Checks PostgreSQL 17 (pgvector) container
 * 2. Applies all native database migrations
 * 3. Optionally downloads SigLIP2 ONNX models (needs VERITY_MODELS_CDN_URL)
 *
 * Usage:
 *   npm run setup
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

// Auto-load .env and .env.local into process.env so all child scripts inherit them
for (const envFile of ['.env', '.env.local']) {
  const filePath = resolve(ROOT, envFile);
  if (existsSync(filePath)) {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '').trim();
      }
    }
  }
}

console.log('\n=============================================================');
console.log('🚀 VerityDAM — Thiết lập môi trường phát triển cục bộ');
console.log('=============================================================\n');

function run(command, description, cwd = ROOT, optional = false) {
  console.log(`⏳ ${description}...`);
  try {
    execSync(command, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        PYTHONPATH: resolve(ROOT, 'backend'),
      },
    });
    console.log(`✅ ${description} hoàn tất.\n`);
  } catch (error) {
    if (optional) {
      console.warn(`⚠️  ${description} bị bỏ qua: ${error.message}
`);
      return;
    }
    console.error(`❌ ${description} thất bại:`, error.message);
    process.exit(1);
  }
}

// 1. Kiểm tra file .env.local
const envLocalPath = resolve(ROOT, '.env.local');
if (!existsSync(envLocalPath)) {
  console.warn('⚠️  Chưa tìm thấy file .env.local!');
  console.warn('👉 Hãy copy từ .env.example: cp .env.example .env.local');
  console.warn('👉 Điền các khóa truy cập R2 được cấp trước khi tiếp tục.\n');
}

// 2. Kiểm tra Docker PostgreSQL
console.log('🔍 Kiểm tra PostgreSQL container (verity_postgres)...');
try {
  const dockerPs = execSync('docker ps --filter "name=verity_postgres" --format "{{.Status}}"', {
    encoding: 'utf8',
  }).trim();

  if (!dockerPs || !dockerPs.includes('Up')) {
    console.log('⚠️  Container verity_postgres chưa chạy. Đang thử khởi động lại...');
    try {
      execSync('docker start verity_postgres', { stdio: 'inherit' });
      console.log('✅ Đã khởi động lại container verity_postgres.\n');
    } catch {
      console.log('ℹ️  Đang khởi tạo container verity_postgres mới qua Docker...');
      execSync(
        'docker run -d --name verity_postgres -p 127.0.0.1:5432:5432 -e POSTGRES_DB=verity_dam -e POSTGRES_USER=verity -e POSTGRES_PASSWORD=verity_dev_only pgvector/pgvector:pg17',
        { stdio: 'inherit' }
      );
      console.log('✅ Đã tạo mới container verity_postgres.\n');
    }
  } else {
    console.log('✅ Container verity_postgres đang chạy tốt.\n');
  }
} catch {
  console.warn('⚠️  Không thể kiểm tra Docker tự động. Hãy đảm bảo PostgreSQL 17 đang lắng nghe tại port 5432.\n');
}

// 3. Chạy 51 Database Migrations
run('python -m scripts.apply_native_migrations', 'Nạp Database Migrations', resolve(ROOT, 'backend'));

// 4. Tải Model SigLIP2 ONNX (tùy chọn: cần VERITY_MODELS_CDN_URL hoặc tự đặt file vào backend/models/)
run('python backend/scripts/download_siglip2_model.py', 'Kiểm tra & Tải mô hình SigLIP2 ONNX', ROOT, true);

console.log('=============================================================');
console.log('🎉 TẤT CẢ CÁC BƯỚC ĐÃ HOÀN TẤT!');
console.log('👉 Bây giờ bạn có thể khởi chạy server Next.js:');
console.log('     npm run dev');
console.log('👉 Truy cập http://localhost:3000 để bắt đầu trải nghiệm!');
console.log('=============================================================\n');
