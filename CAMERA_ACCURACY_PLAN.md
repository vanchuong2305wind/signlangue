# Kế hoạch nâng độ chính xác dịch camera → chữ (câu nhiều từ)

## Chẩn đoán gốc rễ

Model hiện tại (`train/Sign-Language-Recognition`, checkpoint WLASL100 I3D+Transformer) là bộ phân loại
**từng ký hiệu cô lập** — train trên các clip mà mỗi clip chỉ chứa đúng một từ. Nó không có cơ chế tách từ
(segmentation/CTC) cho một chuỗi ký hiệu liên tục.

Pipeline hiện tại ([Camera.jsx](app/frontend/src/pages/Camera.jsx)) lại cắt khung hình theo **đồng hồ cố định**
(24 khung ~3 giây/lần, không chồng lấp) rồi gửi thẳng cho model, bất kể người dùng đang giữa chừng một ký hiệu
hay đang chuyển tiếp giữa hai ký hiệu. Với 1 từ đơn lẻ, người dùng vô tình canh khớp cửa sổ 3 giây nên đúng.
Với câu nhiều từ ký liên tục, ranh giới 3 giây gần như chắc chắn cắt trúng đoạn chuyển tiếp (tay đang di chuyển
giữa hai tư thế) → model nhận một đoạn "lai" không giống ký hiệu nào nó từng học, nhưng vẫn trả về top-1 với
confidence không quá thấp. Ngưỡng chấp nhận hiện tại (`confidence >= 0.2`, [Camera.jsx:121](app/frontend/src/pages/Camera.jsx#L121))
quá dễ dãi nên các dự đoán "lai" này vẫn lọt vào câu.

Gemini ([sentence_builder.py](app/api/sentence_builder.py)) chỉ ghép lại các từ đã nhận diện — không phải nguồn
gốc lỗi, garbage-in-garbage-out.

## Track A — Tối ưu logic với model hiện tại (làm ngay, không đổi model)

Thứ tự ưu tiên, mỗi bước làm xong sẽ báo cáo trước khi sang bước kế:

1. **[Bước 1 — sẽ thực hiện ngay]** Thay cửa sổ cố định theo thời gian bằng **cắt đoạn theo chuyển động**
   (motion-gated adaptive segmentation) ở frontend:
   - Tính điểm chuyển động mỗi tick (chênh lệch trung bình giữa 2 khung xám liên tiếp trên canvas 320×240 đã có sẵn).
   - State machine: IDLE (tay nghỉ, chỉ giữ pre-roll ngắn) → ACTIVE khi chuyển động vượt ngưỡng bắt đầu → tiếp tục
     gom khung → đóng đoạn khi chuyển động tụt dưới ngưỡng và duy trì yên tĩnh một khoảng ngắn (~300–400ms).
   - Có trần an toàn (ép đóng đoạn nếu ACTIVE quá lâu) và sàn tối thiểu (bỏ qua đoạn quá ngắn/nhiễu) để luôn nằm
     trong giới hạn khung hình backend chấp nhận (12–48, sẽ nới trần một chút cho khớp cơ chế mới).
   - Đây là điểm khiến việc "nghỉ ngắn giữa hai ký hiệu" (gợi ý đã có sẵn trong UI) thực sự có tác dụng, thay vì
     bị bỏ qua bởi đồng hồ cố định.

2. Siết ngưỡng chấp nhận từ vào câu:
   - Nâng `confidence >= 0.2` lên mức chặt hơn.
   - Thêm kiểm tra biên độ giữa top-1 và top-2 (model đã trả `alternatives` sẵn, không tốn thêm API) để loại các
     dự đoán mơ hồ dù confidence thô vẫn qua được ngưỡng.

3. (Tinh chỉnh thêm, làm sau khi 1–2 đã kiểm chứng) Cắt bớt khung gần như đứng yên ở đầu/cuối đoạn tại backend
   trước khi resample về 64 khung ([camera_recognition.py:_preprocess](app/api/camera_recognition.py#L78)), để
   64 khung được lấy mẫu tập trung vào chuyển động thật thay vì khung "chết" do sai số ngưỡng phía client.

4. (Tinh chỉnh thêm) Thêm cooldown ngắn ngay sau khi một từ được chấp nhận, tránh phần đuôi của cử chỉ vừa nhận
   diện (tay đang về vị trí nghỉ) lẫn vào pre-roll của đoạn kế tiếp.

## Track B — Khảo sát model open-source cho continuous SLR

Đã khảo sát qua web (không chỉ dựa trí nhớ) và **clone 2 repo triển vọng nhất** vào `train/` để nghiên cứu sau
— chưa tích hợp gì vào app.

### Đã clone

1. **`train/slt_how2sign_wicv2023`** (`imatge-upc/slt_how2sign_wicv2023`, MIT, CVPR WiCV 2023) — ⭐ ứng viên
   sát nhu cầu nhất: dịch **video ASL liên tục → câu tiếng Anh** (đúng bài toán "câu nhiều từ" đang gặp lỗi),
   train trên **How2Sign** (dataset ASL liên tục, video hướng dẫn có phụ đề). Có sẵn code train + infer
   (Fairseq), có checkpoint pretrained tải trên Dataverse (`baseline_6_3_dp03_wd_2` là bản tốt nhất, ~12.4 BLEU).
   Lưu ý quan trọng trước khi cân nhắc tích hợp:
   - Input là **đặc trưng I3D đã trích xuất sẵn** (.npy), không phải video thô — cần thêm bước trích xuất
     feature giống pipeline How2Sign, không cắm thẳng vào `camera_recognition.py` được.
   - BLEU ~12.4 vẫn thấp (continuous SLT nói chung còn rất khó) — kỳ vọng câu ra không hoàn hảo, cần đánh giá
     thực tế trên dữ liệu của mình trước khi thay thế Gemini-stitching hiện tại.
   - Domain How2Sign là video hướng dẫn (instructional), có thể lệch với ngữ cảnh ký hiệu tự do của app.

2. **`train/CorrNet`** (`hulianyuyy/CorrNet` + CorrNet+, đang được maintain tích cực, cập nhật gần nhất
   01/2025–11/2025) — baseline continuous sign language **recognition** (xuất chuỗi gloss, chưa phải câu hoàn
   chỉnh) mạnh, có pretrained checkpoint (Google Drive/Baidu), 19.4% WER trên PHOENIX2014. Nhưng train trên
   **tiếng Đức (PHOENIX)** và **tiếng Trung (CSL-Daily)** — không phải ASL, nên checkpoint không dùng trực tiếp
   được cho app; giá trị chính là tham khảo **kiến trúc** (cách họ giải quyết đúng vấn đề "gộp nhiều từ liền
   nhau" bằng temporal correlation module) để áp dụng ý tưởng, không phải để lấy weight.

### Đã xem qua nhưng không clone (ít giá trị hơn 2 repo trên)

- `AI4Bharat/OpenHands` — repo đã **ngừng bảo trì** ("No longer actively maintained"), chỉ làm nhận diện từ
  đơn lẻ (cùng loại bài toán với model hiện tại, không phải continuous) — không có gì mới hơn.
- `neccam/slt`, `ycmin95/VAC_CSLR` — cùng nhóm continuous recognition cho PHOENIX (Đức), bị `CorrNet` vượt qua
  về kết quả và mức độ cập nhật, giữ CorrNet làm đại diện cho nhóm này là đủ.
- Google "Scaling Sign Language Translation" (YouTube-ASL, arXiv 2407.11855) — không tìm thấy code/checkpoint
  công khai, chỉ có paper.

### Kết luận sơ bộ

Chưa có repo nào "chạy thẳng, chính xác hơn hẳn" mà không cần thêm việc: `slt_how2sign_wicv2023` đúng bài toán
(ASL, liên tục, có checkpoint) nhưng cần build lại pipeline trích xuất feature I3D và BLEU còn thấp; `CorrNet`
kiến trúc tốt nhưng sai ngôn ngữ ký hiệu. Bước tiếp theo nếu muốn đi xa hơn: chạy thử checkpoint của
`slt_how2sign_wicv2023` trên vài clip mẫu để đánh giá chất lượng thực tế trước khi quyết định có đáng để xây
pipeline tích hợp hay không.

## Trạng thái

- [x] Bước A1 — đã cài trong `Camera.jsx` (motion-gated segmentation thay đồng hồ cố định 3 giây).
      Vòng 1 dùng trung bình cả khung hình → cử chỉ nhỏ/khu trú gần mặt (vd "who") bị pha loãng bởi nền đứng
      yên nên không kích hoạt được, chỉ cử chỉ đưa tay ra xa mới đủ điểm. Đã sửa sang tính theo **lưới khối**
      (8×6 ô trên bản downsample 64×48, lấy điểm ô cao nhất thay vì trung bình toàn khung) để một vùng nhỏ
      chuyển động mạnh vẫn được phát hiện, không bị pha loãng. Vẫn cần test thực tế để tinh chỉnh
      `MOTION_START_THRESHOLD` / `MOTION_STOP_THRESHOLD`.
- [x] Bước A2 — đã siết ngưỡng chấp nhận từ ([Camera.jsx:29-32](app/frontend/src/pages/Camera.jsx#L29-L32),
      [Camera.jsx:152-161](app/frontend/src/pages/Camera.jsx#L152-L161)): `confidence >= 0.2` → `>= 0.45`, và
      thêm điều kiện biên độ top1 − top2 `>= 0.12` (loại các dự đoán model đang phân vân). Chỉ lọc bớt từ
      sai/rác trước khi vào câu — **không** sửa được lỗi gộp 2 từ liền nhau thành 1 đoạn (xem ghi chú dưới).
- [x] Bước A3 — đã thêm `_trim_static_edges` ở backend ([camera_recognition.py](app/api/camera_recognition.py#L78-L108)):
      trước khi resample về 64 khung, cắt bớt các khung gần như đứng yên ở đầu/cuối đoạn (ngưỡng tính động theo
      chuyển động trung bình của chính clip đó, không phải hằng số cố định) để 64 khung tập trung vào chuyển
      động thật thay vì khung "chết" do sai số ngưỡng phía client.
- [x] Bước A4 — đã thêm cooldown 2 tick (~250ms) sau khi một đoạn đóng do **phát hiện tay dừng tự nhiên**
      ([Camera.jsx:21-24](app/frontend/src/pages/Camera.jsx#L21-L24), [Camera.jsx:228-236](app/frontend/src/pages/Camera.jsx#L228-L236),
      [Camera.jsx:267-272](app/frontend/src/pages/Camera.jsx#L267-L272)): tránh phần tay đang "rơi" về vị trí
      nghỉ vừa lẫn vào pre-roll của từ kế tiếp, vừa dễ tự kích hoạt nhầm một đoạn mới. Không áp dụng khi đoạn bị
      ép cắt do chạm trần `MAX_SEGMENT_FRAMES` (lúc đó tay vẫn đang động, cần bắt lại ngay).
- [x] Track B — đã khảo sát + clone `train/slt_how2sign_wicv2023` và `train/CorrNet` để nghiên cứu sau.
      Chưa đánh giá chất lượng thực tế, chưa tích hợp — xem "Kết luận sơ bộ" ở trên.

### Giới hạn còn lại (chưa nằm trong A1–A4)

Cả 4 bước trên **không giải quyết được** trường hợp người dùng ký liên tục, tay không dừng hẳn giữa 2 từ: đoạn
sẽ bị gộp thành 1 clip "từ 1 + chuyển tiếp + từ 2" và model chỉ đoán ra một nhãn (thường sai) cho cả cục gộp.
Nguyên nhân: cơ chế đóng đoạn hiện tại chỉ dựa vào "tay dừng hẳn" (motion tụt dưới ngưỡng), không phân biệt được
"tay chậm lại giữa 2 từ" với "tay chưa từng dừng". Hướng khắc phục (chưa làm, cần thảo luận thêm trước khi cài
vì phức tạp hơn đáng kể): phát hiện **điểm trũng cục bộ** (local minimum) trong đường motion score để tách ranh
giới 2 từ ngay cả khi không có khoảng lặng thật sự, thay vì chỉ so với một ngưỡng tuyệt đối.
