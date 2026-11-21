# PROJECT_NOTES.md

## Mục đích
Ứng dụng nhắn tin ẩn danh công khai tức thời (ephemeral anonymous messaging board), toàn bộ tin nhắn tự hủy sau 30 phút.

## Công nghệ
- Frontend: React 19, Vite 6, TypeScript, Tailwind CSS v4, `vite-plugin-pwa`.
- Backend: Express + `ws` (WebSocket) chạy trên Node.js (`server.ts`), lưu trữ thuần RAM (tối đa 500 tin nhắn còn hạn 30 phút).

## Cấu trúc file chính & vai trò
- `index.html`: Shell HTML nền tối `#09090b`, tải font bất đồng bộ (không chặn First Paint), tiêu đề trống (`ㅤ`).
- `src/main.tsx`: Đăng ký Service Worker an toàn (try/catch) và mount `ErrorBoundary` + `App`.
- `src/ErrorBoundary.tsx`: Bắt lỗi runtime, hỗ trợ dọn Service Worker cũ và tải lại trang.
- `src/index.css`: Tailwind v4, cấu hình cuộn mượt cảm ứng, `content-visibility: auto`, hỗ trợ `select-text` trên iOS/Android, `touch-action: manipulation`, và `prefers-reduced-motion`.
- `src/App.tsx`: Giao diện chính gồm luồng tin nhắn công khai (progressive windowing 80 tin/lần), `MicroTicker` 1Hz tạm dừng khi ẩn tab, nhận diện link và modal cảnh báo chuyển hướng 100% tiếng Anh, nút trượt nhanh xuống mới nhất, hàng đợi gửi lại khi mất mạng, đồng bộ đa tab qua `BroadcastChannel`.
- `server.ts`: HTTP/WebSocket server (`TCP_NODELAY`, `perMessageDeflate: false`), tự dọn tin hết hạn mỗi 5s, heartbeat `ping/pong` dọn socket chết mỗi 30s, cache header cho static assets production.

## Quy ước & Ràng buộc
- Giữ giao diện tối giản cao cấp nền tối hiện tại, chỉ là ứng dụng nhắn tin ẩn danh thuần túy (không thêm tính năng thừa như nickname, phòng chat phức tạp, thanh trạng thái rườm rà).
- Modal xác nhận liên kết ngoài bắt buộc hiển thị 100% tiếng Anh (`External Link Warning`, `Cancel`, `Continue`).
- Tiêu đề trang luôn giữ trống (`ㅤ`).

## Lỗi đã xử lý & Tối ưu
- Tải font render-blocking gây chậm hiển thị trên mạng yếu → chuyển sang tải bất đồng bộ với `media="print" onload="this.media='all'"`.
- Layout thrashing khi gõ ở textarea (`height = 'auto'` mỗi phím) và đối soát `O(N^2)` → chỉ reset `auto` khi thu gọn nội dung, dùng `Set` cho đối soát `O(N)`, và windowing 80 tin nhắn DOM để giữ 60fps trên máy yếu.
- Khắc phục `-webkit-user-select: text` cho `.select-text` trên trình duyệt di động và bỏ `backdrop-blur`/`animate-pulse` tốn GPU.
- Khắc phục WebSocket zombie (half-open không báo `close`) bằng ping/pong watchdog 3.5s, `TCP_NODELAY` + `setKeepAlive`, fallback HTTP ngay khi mất kết nối, `upsertMessageFast` `O(1)` không re-sort toàn bộ danh sách, và `useLayoutEffect` cập nhật cuộn 0-frame.

