const axios = require("axios");
const moment = require("moment-timezone");

/**
 * TikTok search & download (tikwm.com)
 * - search: tiktok search <keyword>
 * - reply STT để tải video
 */

module.exports.config = {
  name: "tiktok",
  version: "1.2.1",
  hasPermssion: 0,
  credits: "DongDev + Nauth",
  description: "Thông tin từ nền tảng TikTok",
  commandCategory: "Tìm kiếm",
  usages: "tiktok search <keyword>",
  cooldowns: 5,
  images: []
};

module.exports.run = async function ({ api, event, args }) {
  const { threadID: tid, messageID: mid, senderID: sid } = event;

  // helper nhận cả messageID hoặc callback (giống capcut m xài)
  const send = (content, tid, third, fourth) => {
    if (typeof third === "function") return api.sendMessage(content, tid, third, fourth);
    return api.sendMessage(content, tid, third);
  };

  if (!args[0] || args[0] !== "search") {
    return send("📝 Dùng: tiktok search <từ khóa>", tid, mid);
  }

  const keyword = args.slice(1).join(" ").trim();
  if (!keyword) return send("⚠️ Nhập từ khóa cần tìm.", tid, mid);

  try {
    const list = await getData(keyword);
    if (!Array.isArray(list) || list.length === 0) {
      return send("❌ Không tìm thấy kết quả.", tid, mid);
    }

    const results = list.slice(0, 7);

    // ảnh xem trước: cover / origin_cover / thumbnail
    const thumbs = await Promise.all(
      results.map(item => {
        const thumb =
          item.cover ||
          item.origin_cover ||
          item.dynamic_cover ||
          (item.images && item.images[0]) ||
          null;
        return thumb ? streamURL(thumb, "jpg") : null;
      })
    ).then(arr => arr.filter(Boolean));

    const listMessage = results.map((r, i) => {
      const title = r.title || r.desc || "(không tiêu đề)";
      const authorName =
        (r.author && (r.author.nickname || r.author.unique_id)) ||
        r.author ||
        "Unknown";
      return `|› ${i + 1}. Title: ${title}\n|› Tác giả: ${authorName}\n──────────────────`;
    }).join("\n");

    api.sendMessage(
      {
        body: `[ TikTok Search For Videos ]\n──────────────────\n${listMessage}\n\n📌 Reply (phản hồi) STT để tải video`,
        attachment: thumbs
      },
      tid,
      (error, info) => {
        if (error) return console.error("Error sending message:", error);
        global.client.handleReply.push({
          type: "tiktok_search",
          name: module.exports.config.name,
          author: sid,
          messageID: info.messageID,
          result: results
        });
      }
    );
  } catch (err) {
    console.error("Error (search):", err?.message || err);
    send("🚨 Đã xảy ra lỗi, thử lại sau.", tid, mid);
  }
};

module.exports.handleReply = async function ({ event, api, handleReply }) {
  const { threadID: tid, messageID: mid, body, senderID: sid } = event;

  if (handleReply.type !== "tiktok_search") return;
  if (sid !== handleReply.author) {
    return api.sendMessage("⚠️ Không phải lời mời của bạn.", tid, mid);
  }

  const choose = parseInt((body || "").trim(), 10);
  api.unsendMessage(handleReply.messageID);

  if (isNaN(choose)) return api.sendMessage("⚠️ Vui lòng nhập 1 con số.", tid, mid);
  if (choose < 1 || choose > handleReply.result.length) {
    return api.sendMessage("❎ Lựa chọn không nằm trong danh sách.", tid, mid);
  }

  try {
    const chosen = handleReply.result[choose - 1];

    // Ưu tiên không watermark -> có watermark
    const videoUrl = chosen.play || chosen.play_addr || chosen.wmplay || chosen.url;
    if (!videoUrl) throw new Error("Không có URL video hợp lệ.");

    const videoStream = await streamURL(videoUrl, "mp4");
    if (!videoStream) throw new Error("Tải stream thất bại.");

    const title = chosen.title || chosen.desc || "(không tiêu đề)";
    const authorName =
      (chosen.author && (chosen.author.nickname || chosen.author.unique_id)) ||
      chosen.author ||
      "Unknown";

    const stats = chosen.stats || {};
    const created = chosen.create_time
      ? moment(chosen.create_time * 1000).tz("Asia/Ho_Chi_Minh").format("HH:mm:ss - DD/MM/YYYY")
      : "N/A";

    const bodyMsg =
      `[ TikTok Video Info ]\n` +
      `──────────────────\n` +
      `|› Tiêu đề: ${title}\n` +
      `|› Tác giả: ${authorName}\n` +
      `|› Lượt xem: ${stats.play_count ?? "N/A"}\n` +
      `|› Lượt thích: ${stats.digg_count ?? "N/A"}\n` +
      `|› Lượt comment: ${stats.comment_count ?? "N/A"}\n` +
      `|› Ngày tải lên: ${created}`;

    api.sendMessage({ body: bodyMsg, attachment: videoStream }, tid, mid);
  } catch (err) {
    console.error("Error (download):", err?.message || err);
    api.sendMessage("🚨 Đã xảy ra lỗi khi tải video.", tid, mid);
  }
};

/* ========== Helpers ========== */

async function streamURL(url, ext = "mp4") {
  try {
    const res = await axios.get(url, { responseType: "stream", timeout: 30000 });
    res.data.path = `tiktok.${ext}`; // gắn filename để Messenger nhận file
    return res.data;
  } catch (e) {
    console.error("streamURL error:", e?.message || e);
    return null;
  }
}

async function getData(keyword) {
  try {
    const res = await axios.get("https://tikwm.com/api/feed/search", {
      params: { keywords: keyword, count: 30 },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
      },
      timeout: 15000
    });

    // tikwm thường trả: { code: 0, msg: "success", data: [...] }
    const payload = res?.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.videos)) return payload.data.videos;
    if (Array.isArray(payload?.data?.data)) return payload.data.data;
    return [];
  } catch (error) {
    console.error("Error fetching data from API:", error?.message || error);
    return [];
  }
}