import cv2
import mediapipe as mp

mp_hands = mp.solutions.hands
mp_drawing = mp.solutions.drawing_utils
mp_drawing_styles = mp.solutions.drawing_styles

hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

cap = cv2.VideoCapture(0)

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break

    frame = cv2.flip(frame, 1)
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = hands.process(rgb)

    if results.multi_hand_landmarks:
        for hand_landmarks, handedness in zip(
            results.multi_hand_landmarks, results.multi_handedness
        ):
            label = handedness.classification[0].label  # "Left" / "Right"
            h, w, _ = frame.shape

            # Vẽ 21 điểm và kết nối
            mp_drawing.draw_landmarks(
                frame, hand_landmarks, mp_hands.HAND_CONNECTIONS,
                mp_drawing_styles.get_default_hand_landmarks_style(),
                mp_drawing_styles.get_default_hand_connections_style()
            )

            # Hiển thị tọa độ 21 điểm
            for idx, lm in enumerate(hand_landmarks.landmark):
                cx, cy = int(lm.x * w), int(lm.y * h)
                cv2.putText(frame, str(idx), (cx - 5, cy - 5),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.3, (255, 255, 0), 1)

            # Hiển thị nhãn tay
            wrist = hand_landmarks.landmark[0]
            wx, wy = int(wrist.x * w), int(wrist.y * h)
            cv2.putText(frame, label, (wx, wy - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

    cv2.imshow("Hand Landmark Detection", frame)
    if cv2.waitKey(1) & 0xFF == 27:  # ESC để thoát
        break

cap.release()
cv2.destroyAllWindows()
hands.close()
