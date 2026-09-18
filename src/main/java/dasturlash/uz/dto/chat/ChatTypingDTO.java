package dasturlash.uz.dto.chat;

import dasturlash.uz.dto.attach.AttachDTO;
import dasturlash.uz.dto.profile.ProfileDTO;
import dasturlash.uz.enums.ChatMessageType;
import dasturlash.uz.enums.ChatType;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

@Getter
@Setter
@AllArgsConstructor
public class ChatTypingDTO {
    private String name;
    private String typingChatId;

}