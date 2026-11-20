"""Learning topics curated from Vietnamese meanings, independent of ASL glosses.

These are application categories, not annotations supplied by VieSign. Exact
terms and specific phrase prefixes keep ambiguous labels in 'other'. Adding a
term here never changes its label, landmark, or extraction provenance.
"""

import re

from .viesign_dataset import normalize_word


def _terms(text: str) -> set[str]:
    return {normalize_word(term) for term in text.split("|") if term.strip()}


CATEGORY_TERMS = {
    "greetings": _terms("""
        chào | xin chào | tạm biệt | xin lỗi | cảm ơn | cám ơn | cảm tạ |
        chào hỏi | chúc mừng | chúc ngủ ngon | chúc mừng năm mới | chúc mừng sinh nhật |
        hẹn gặp lại | hoan nghênh | đón tiếp | thăm hỏi | tên là gì?
    """),
    "family": _terms("""
        gia đình | ông | bà | ông bà | ông nội | ông ngoại | bà nội | bà ngoại |
        bố | cha | mẹ | ba | cha mẹ | bố mẹ | bố dượng | mẹ kế | anh | chị | em |
        anh chị | anh chị em | anh em | chị em | anh hai | anh trai | anh ruột |
        anh họ | anh rể | anh vợ | chị gái | chị ruột | chị họ | chị dâu |
        em gái | em trai | em họ | em dâu | em rể | con | con trai | con gái |
        cháu | cháu trai | cháu gái | cháu nội | cháu ngoại | vợ | chồng |
        vợ chồng | cô | dì | chú | bác | cậu | thím | mợ | cụ | tổ tiên |
        họ hàng | dòng họ | đám cưới | cô dâu | chú rể | kết hôn | ly hôn
    """),
    "food_drink": _terms("""
        ăn | uống | đồ ăn | đồ uống | thực phẩm | bữa cơm | cơm | bún | phở |
        bánh | bánh mì | mì | mì tôm | mì ăn liền | miến | cháo | canh | súp |
        xôi | cốm | gạo | thóc | ngô | bỏng ngô | thịt | cá | trứng | rau |
        tôm | cua | ốc | muối | đường | nước mắm | dầu ăn | tương ớt |
        cà phê | trà | trà sữa | trà đá | trà nóng | nước uống | nước ngọt |
        nước cam | nước chanh | nước ép | nước dừa | nước lọc | nước khoáng |
        bia | rượu | sữa | sữa bò | sữa dê | sữa bột | sữa chua | sữa hộp | sữa đặc |
        7up | coca cola | chanh muối | chanh nóng | chanh đá | sinh tố | kem |
        bít tết bò | vịt quay | xoài | cam | chanh | chuối | táo | ổi | mít |
        dưa hấu | nho | nhãn | vải | dứa | đu đủ | dừa | bưởi | măng cụt |
        cà chua | cà rốt | khoai | khoai lang | khoai tây | bí xanh | bí đỏ |
        bắp cải | bắp ngô | súp lơ | đậu | đậu phụ | đậu xanh | đậu đen |
        hành | tỏi | gừng | nghệ | ớt | mướp | rau muống | rau cải | rau ngót |
        cà tím | dưa chuột | dưa leo | lạc | mía | kẹo | thạch | mứt
    """),
    "emotions": _terms("""
        vui | vui mừng | vui sướng | vui tính | buồn | buồn thảm | buồn bã |
        hạnh phúc | đau khổ | đau lòng | giận | giận dữ | giận dỗi | bực mình |
        tức giận | căm thù | ghét | yêu | yêu mến | thương yêu | tình yêu | tình cảm |
        tôi yêu bạn | tôi yêu bạn ấy | bạn yêu tôi | bạn yêu bạn ấy | bạn ấy yêu tôi |
        bạn ấy yêu bạn | sợ | sợ hãi | lo | lo lắng | lo âu | hồi hộp | ngạc nhiên |
        bất ngờ | tự tin | tự hào | tự ti | xấu hổ | e thẹn | ngượng ngùng |
        cô đơn | thất vọng | tuyệt vọng | hi vọng | hy vọng | mong muốn | bối rối |
        ghen tị | ghen ghét | bình tĩnh | thoải mái | dễ chịu | khó chịu | yên tâm |
        yên lòng | tủi thân | ác cảm | ân hận | hối hận | tiếc | tiếc nuối |
        nhớ | nhung nhớ | thán phục | trầm trồ | thích thú | thân thiện | dịu dàng |
        cau có | ức chế | vô tư | thản nhiên | vô lo vô nghĩ | cảm động | xúc động
    """),
    "education": _terms("""
        học | học sinh | sinh viên | giáo viên | thầy giáo | cô giáo | thầy cô |
        trường học | trường mầm non | trường cấp một | trường cấp hai | trường cấp ba |
        tiểu học | trung học | đại học | cao đẳng | giáo dục | ban giám hiệu |
        đi học | vào lớp | lớp học | dạy | dạy học | đào tạo | du học | học tập |
        sách | vở | bút | bút bi | bút chì | bút dạ | bút màu | bút máy | bút mực |
        bảng | bảng đen | bảng học sinh | bảng chữ cái ngón tay | cặp sách | ba lô |
        bài tập | bài thơ | bài văn | bìa sách | bìa vở | bọc sách | bụi phấn |
        phấn | phấn viết | cục tẩy | thước kẻ | ê ke | giấy nháp | giấy khen |
        giấy màu | tẩy | đọc | đọc sách | viết | vẽ | tập viết | tập làm văn |
        thi | thi cử | kiểm tra | ôn tập | ôn luyện | thực hành | thí nghiệm |
        học thuộc | học thuộc lòng | ghi chép | ghi chú | ghi nhớ | học phí |
        ngữ pháp | danh từ | danh từ riêng | động từ | tính từ | chủ ngữ | vị ngữ |
        bổ ngữ | cụm từ | từ ngữ | từ trái nghĩa | trái nghĩa | từ đồng âm |
        tiếng anh | tin học | địa lí | toán | toán học | đại số | hình học |
        lịch sử | ngữ văn | văn | khoa học | môn học | thời khóa biểu | bế giảng |
        khai giảng | tốt nghiệp | sân trường | cổng trường | đồ dùng học tập |
        đồ dùng dạy học | giá sách | bộ sách | bộ truyện | sổ điểm danh | sổ đầu bài |
        diện tích | chu vi | thể tích | bán kính | đường kính | đường thẳng |
        đoạn thẳng | đường tròn | tam giác | hình vuông | hình tròn | hình chữ nhật |
        hình thang | hình thoi | hình bình hành | vuông góc | song song | đối xứng |
        phân số | số thập phân | số chẵn | số lẻ | cộng | trừ | nhân | chia |
        tính nhẩm | tính toán | bảng cửu chương | bảng cộng | bảng trừ | bảng nhân |
        bảng chia | công thức | dãy số | dãy số liệu | trục hoành | trục tung |
        trung điểm | tỉ lệ | tỉ số | tỉ số phần trăm | số đo | giá trị tuyệt đối
    """),
    "daily_life": _terms("""
        nhà | ngôi nhà | sân nhà | ban công | sân thượng | phòng | phòng khách |
        phòng ngủ | phòng bếp | nhà bếp | nhà vệ sinh | phòng tắm | trần nhà |
        bức tường | tường | cột nhà | cửa | cửa sổ | cửa ra vào | cửa kính |
        bàn | ghế | bàn ghế | ghế sofa | ghế sô pha | giường | tủ | tủ lạnh |
        bếp ga | bát | đĩa | đũa | thìa | cốc | chai | ấm trà | ấm đun nước |
        bồn tắm | bồn rửa bát | bồn rửa mặt | bồn cầu | bệ xí | vòi nước |
        gương | lược | khăn | khăn mặt | khăn tắm | xà phòng | xà phòng giặt |
        sữa rửa mặt | sữa tắm | dầu gội đầu | bột giặt | giẻ lau | thùng rác |
        điện thoại | máy tính | máy vi tính | máy giặt | quạt | máy quạt |
        điều hòa | tivi | ti-vi | đèn pin | đèn điện | bàn là | bật lửa |
        áo | quần | quần áo | giày | giầy dép | dép | mũ | nón | váy | tất |
        bít tất | sơ mi | đồng phục | trang phục | ba lô | túi | ví | ví tiền |
        đi vệ sinh | vệ sinh cá nhân | đánh răng | rửa mặt | rửa tay | rửa bát |
        tắm | giặt | giặt quần áo | lau nhà | quét nhà | nấu ăn | đun nấu |
        chải tóc | trang điểm | ngủ | giấc ngủ | thức | thức dậy | nghỉ ngơi |
        đóng cửa | mở cửa | bật đèn | tắt đèn | cất quần áo | trùm chăn |
        mua sắm | mua | bán | tiền | tiền bạc | đồng tiền | tờ tiền
    """),
    "health": _terms("""
        sức khỏe | y tế | bác sĩ | y tá | bệnh | bệnh nhân | bệnh viện | trạm y tế |
        thuốc | thuốc bắc | thuốc bổ | đơn thuốc | cấp cứu | điều trị | khám bệnh |
        tiêm | truyền dịch | bó bột | băng bó | băng gạc | ống nghe | nhiệt kế |
        đau | đau bụng | đau chân | đau mắt | đau mắt đỏ | đau tai | đau tay |
        đau đầu | đau răng | đau lưng | đau họng | ốm đau | sốt | ho | cảm cúm |
        sổ mũi | buồn nôn | nôn | nôn mửa | tiêu chảy | sưng | ung thư |
        vi khuẩn | vi rút | cô vy | cô vy (covid) | dịch bệnh | bệnh tật |
        bệnh thủy đậu | bệnh phong/cùi | bệnh đao - down | tâm thần | sâu răng |
        dị ứng | tái phát | trầy xước | đứt tay | vết thương | chảy máu | khuyết tật |
        khiếm thính | khiếm thị | người điếc | người mù | điếc | mù | câm |
        cơ thể | cơ bắp | đầu | tóc | mặt | mắt | tai | mũi | miệng | răng | lưỡi |
        cổ | cổ họng | vai | ngực | bụng | lưng | tay | chân | bàn tay | bàn chân |
        ngón tay | ngón chân | đầu gối | cổ tay | cổ chân | cùi chỏ | khuỷu tay |
        tim | gan | phổi | thận | dạ dày | ruột | não | óc | máu | xương |
        cột sống | xương sống | xương sườn | tủy sống | tuỷ sống | dây thần kinh |
        thần kinh | buồng trứng | tinh trùng | tránh thai | tiêu hoá | thị lực
    """),
    "time_weather": _terms("""
        thời gian | giờ | phút | giây | ngày | tuần | tháng | năm | hôm nay |
        hôm qua | ngày mai | ngày kia | hôm kia | bây giờ | bao giờ | lúc nào |
        khi nào | sáng | trưa | chiều | tối | đêm | ban ngày | ban đêm | cả ngày |
        buổi sáng | buổi trưa | buổi chiều | buổi tối | buổi đêm | bình minh |
        hoàng hôn | thứ hai | thứ ba | thứ tư | thứ năm | thứ sáu | thứ bảy | chủ nhật |
        tuần này | tuần trước | tuần sau | tháng này | tháng trước | tháng sau |
        năm nay | năm trước | năm sau | quá khứ | hiện tại | tương lai | xưa |
        đồng hồ | đồng hồ treo tường | đồng hồ đeo tay | thời gian biểu | thường xuyên |
        mùa | mùa xuân | mùa hè | mùa hạ | mùa thu | mùa đông | giao thừa |
        tết âm | tết dương | trung thu | tết trung thu | tết hàn thực | tết thiếu nhi |
        thời tiết | trời | bầu trời | nắng | mưa | gió | gió lào | giông bão |
        bão | mây | đám mây | trăng | vầng trăng | mặt trăng | mặt trời | tia nắng |
        tuyết | sương | sương mù | sương gió | sấm | sấm chớp | sấm sét | tia chớp |
        cầu vồng | cầu vòng | lạnh | nóng | rét | ấm áp | ẩm ướt | băng giá |
        u ám | lũ | lũ lụt | hạn hán | sóng thần | triều cường
    """),
    "actions": _terms("""
        đi | chạy | nhảy | đứng | ngồi | nằm | bước | bò | leo | trèo | bay |
        bơi | bơi lội | đi dạo | tập thể dục | vận động | di chuyển | dừng lại |
        mang | vác | xách | kéo | đẩy | nâng | cầm | nắm | buông | thả | bắt |
        đánh | đá | ném | tung | đập | bẻ | cắt | xé | dán | gấp | đan | dệt |
        cõng | ôm | cúi | cúi đầu | giơ tay | vẫy tay | vỗ tay | nhặt | đỡ |
        mở | đóng | bật | tắt | đặt | đựng | cho | lấy | đưa | nhận | tìm |
        nhìn | xem | nghe | nói | hỏi | trả lời | gọi | bảo | giúp đỡ | cứu |
        sửa chữa | xây | trồng cây | tưới cây | cấy | cấy lúa | gặt | tuốt lúa |
        bóng bàn | bóng chuyền | bóng rổ | bóng đá | cầu lông | đá bóng | đá cầu |
        đánh cầu lông | bắn bi | cướp cờ | trốn tìm | nhảy dây | kéo co | thả diều |
        cờ vua | cờ tướng | ô ăn quan | trò chơi | vui chơi | chơi | cưỡi ngựa |
        đua ngựa | đua thuyền | đua xe máy | câu cá | săn bắn | vận chuyển
    """),
    "animals": _terms("""
        động vật | thú dữ | côn trùng | chó | mèo | gà | vịt | ngan | ngỗng | chim |
        bò | bò tót | bò sát | trâu | lợn | heo | dê | dê con | dê mẹ | cừu | ngựa |
        voi | hổ | sư tử | báo | khỉ | vượn | gấu | gấu trúc | hươu | nai | hươu cao cổ |
        thỏ | chuột | sóc | nhím | cáo | chồn | kangaroo | căng gu ru | rắn | trăn |
        cá sấu | rùa | thằn lằn | tắc kè | ếch | nhái | cóc | cá | tôm | tôm hùm |
        cua | ốc | ốc sên | sò | hến | trai | mực | sứa | sao biển | cá heo | cá voi |
        cá mập | cá ngựa | cá chép | cá vàng | cá rô | cá trê | cá thu | cá ngừ |
        chim bồ câu | chim sẻ | chim én | chim cánh cụt | đại bàng | cú | vẹt |
        công | đà điểu | bướm | ong | kiến | muỗi | ruồi | gián | nhện | chuồn chuồn |
        châu chấu | dế | sâu | sâu bọ | giun | bọ ngựa | bọ rùa | đom đóm |
        đàn bướm | đàn kiến | sừng | sừng bò | sừng trâu | đuôi chuột | đuôi cá |
        tổ chim | sủa | thú y | vườn thú
    """),
    "colors_numbers": _terms("""
        màu | màu sắc | bảng màu | đỏ | xanh | xanh lá cây | xanh lá | xanh da trời |
        xanh dương | vàng | đen | trắng | tím | hồng | nâu | xám | cam | da cam |
        đỏ thắm | đen láy | trắng muốt | xanh đậm | xanh nhạt | xanh lơ |
        một | hai | ba | bốn | năm | sáu | bảy | tám | chín | mười | trăm | nghìn |
        ngàn | triệu | tỷ | tỉ | không | số | số không | số một | số hai | số ba |
        số bốn | số năm | số sáu | số bảy | số tám | số chín | số mười | đếm
    """),
}

# Only unambiguous label families use prefixes; no English or opaque VSL IDs.
CATEGORY_PREFIXES = {
    "food_drink": ("bánh ", "bún ", "phở ", "cháo ", "xôi ", "cơm ", "củ "),
    "education": ("học sinh ", "trường học ", "phân số ", "dấu ", "tính chất "),
    "daily_life": ("áo ", "quần ", "giày ", "dép ", "ghế "),
    "health": ("đau ", "bệnh ", "xương ", "ngón tay ", "ngón chân "),
}

CATEGORY_EXCLUSIONS = {
    "food_drink": {"bánh xe", "bánh lái", "củ chi"},
    "education": {"dấu chân", "dấu tay", "dấu vết"},
}


def categories_for(meaning: str) -> list[str]:
    label = normalize_word(meaning)
    base = re.sub(r"\s*\([^)]*\)", "", label).strip()
    categories = [key for key, terms in CATEGORY_TERMS.items()
                  if base not in CATEGORY_EXCLUSIONS.get(key, set())
                  and (label in terms or base in terms
                       or base.startswith(CATEGORY_PREFIXES.get(key, ())))]
    if re.fullmatch(r"\d+(?:[ .,]\d+)*", base) and "colors_numbers" not in categories:
        categories.append("colors_numbers")
    return categories or ["other"]
