const express = require('express');
const controller = require('./qa-session.controller');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

router.get('/', requirePermission('qa_session.view'), controller.listQuestions);
router.get('/:sessionNumber', requirePermission('qa_session.view'), controller.getQuestion);
router.put('/:sessionNumber', requirePermission('qa_session.manage'), controller.updateQuestion);

module.exports = router;
