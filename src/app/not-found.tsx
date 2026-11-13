import Link from 'next/link';

export const metadata = { title: 'Không tìm thấy trang · VerityDAM' };

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4 text-text-1">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <p className="font-mono text-[13px] font-semibold text-text-3">404</p>
        <h1 className="text-[22px] font-bold">Không tìm thấy trang này</h1>
        <p className="text-[14px] leading-relaxed text-text-2">
          Đường dẫn có thể đã bị đổi hoặc không tồn tại. Bạn có thể quay lại Thư viện để tiếp tục làm việc.
        </p>
        <Link
          href="/library"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-verity px-5 text-[13px] font-semibold text-white transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity focus-visible:ring-offset-2"
        >
          Về Thư viện
        </Link>
      </div>
    </main>
  );
}
