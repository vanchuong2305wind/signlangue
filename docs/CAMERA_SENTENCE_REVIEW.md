# Demo duyệt câu Camera

Phạm vi: nhận diện từng ký hiệu, tích luỹ chuỗi từ, tạo đề xuất rồi duyệt câu.
Model camera vẫn phân loại từng ký hiệu trong 224 nhãn; tính năng này không bổ sung
model dịch video ký hiệu liên tục thành nguyên câu.

## Câu demo có từ lặp và phủ định

- Chuỗi gốc: `tôi không muốn đi đi lại lại`
- Câu đề xuất/chỉnh sửa: `Tôi không muốn đi đi lại lại.`
- Hai lần `đi` và hai lần `lại` phải thuộc các sự kiện ký hiệu khác nhau.

Đây cũng là dữ liệu kiểm thử luồng duyệt. Nếu dùng camera thật, chỉ sử dụng các nhãn
có trong `models/camera/vsl224/labels.json`; câu mẫu không bảo đảm model nhận diện
được đủ các từ hoặc nhận diện chính xác trên webcam.

## Các thao tác cần trình diễn

1. Nhận diện các sự kiện và kiểm tra chuỗi gốc, bao gồm từ lặp. Nghỉ tay giữa các
   sự kiện. Một ký hiệu dài bị cắt thành nhiều clip chỉ thêm tối đa một từ được chấp nhận.
2. Dừng dịch và chờ hàng đợi xử lý xong. Bấm **Tạo câu đề xuất**.
3. Đối chiếu hai cột. Cả bản đề xuất lẫn bản ghép tại máy chủ phải giữ từ lặp/phủ định.
   Trước khi xác nhận, nút đọc và sao chép phải bị khoá.
4. Sửa câu nếu cần, ví dụ khôi phục `không` nếu đề xuất AI bỏ sót. Chuỗi gốc bên trái
   phải giữ nguyên. Bấm **Xác nhận câu**, rồi đọc/sao chép và đối chiếu đúng nội dung đã duyệt.
5. Bấm **Hoàn tác** ngay sau xác nhận: trở về bản nháp chưa xác nhận, nút đọc/sao chép
   bị khoá. Xác nhận lại; sửa một ký tự cũng phải làm xác nhận hết hiệu lực.
6. Thử **Bỏ từ cuối**, **Xóa câu**, rồi **Hoàn tác**: khôi phục được chuỗi trước thao tác.
7. Khi đang chờ AI, sửa câu hoặc xoá chuỗi. Phản hồi cũ không được ghi đè nội dung mới.

Prompt giúp hạn chế đổi nghĩa nhưng không bảo đảm kết quả AI đúng; người dùng duyệt
nội dung thực tế trước khi sử dụng. Ranh giới sự kiện dựa vào khoảng nghỉ chuyển động
(ba lần lấy mẫu yên, mỗi lần 125 ms), không phải bộ nhận diện ranh giới ký hiệu đã huấn luyện.

## Kiểm thử không gọi Gemini

Từ thư mục dự án:

```bash
.venv/bin/python -B -m unittest tests.sentence_builder_test -v
cd app/frontend
node --test tests/*.test.js
```

Test kiểm tra từ lặp/phủ định, chống trùng trong cùng sự kiện, xác nhận/hoàn tác,
thu hồi xác nhận khi sửa và bỏ qua phản hồi AI đã lỗi thời. SDK Gemini được mô phỏng
trong test backend; các test này không đo chất lượng nhận diện webcam hoặc chất lượng Gemini thực tế.
