const service = require('./monitoring-cia.service');
const asyncHandler = require('../../shared/async-handler');

const listMessages = asyncHandler(async (req, res) => {
  const { search, is_read, session_number, page, limit } = req.query;
  const result = await service.listMessages(req, {
    search,
    isRead: is_read,
    sessionNumber: session_number,
    page,
    limit,
  });

  return res.json({
    status: 'success',
    data: result.data,
    pagination: result.pagination,
  });
});

const getSummary = asyncHandler(async (req, res) => {
  const summary = await service.getSummary();
  return res.json({
    status: 'success',
    data: summary,
  });
});

const markAsRead = asyncHandler(async (req, res) => {
  const { publicId } = req.params;
  const result = await service.markAsRead(req, publicId);

  if (!result) {
    return res.status(404).json({
      status: 'error',
      message: 'Pesan balasan tidak ditemukan',
    });
  }

  return res.json({
    status: 'success',
    data: result,
  });
});

const markAllAsRead = asyncHandler(async (req, res) => {
  const result = await service.markAllAsRead(req);
  return res.json({
    status: 'success',
    data: result,
  });
});

const syncUnreadMessages = asyncHandler(async (req, res) => {
  const result = await service.syncUnreadMessages();
  return res.json({
    status: 'success',
    data: result,
  });
});

const clearAllMessages = asyncHandler(async (req, res) => {
  const result = await service.clearAllMessages(req);
  return res.json({
    status: 'success',
    message: 'Seluruh data balasan berhasil dihapus dari database',
    data: result,
  });
});

module.exports = {
  listMessages,
  getSummary,
  markAsRead,
  markAllAsRead,
  clearAllMessages,
  syncUnreadMessages,
};
