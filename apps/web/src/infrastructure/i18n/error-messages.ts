import { type ErrorCode } from '@unimailbox/contracts';
import { getLanguage, type Language } from './locale';
export const errorMessages = {
  MCP_DISABLED: { en: 'MCP service is disabled.', 'zh-CN': 'MCP 服务未启用。' },
  MCP_RATE_LIMITED: {
    en: 'MCP request limit exceeded. Try again later.',
    'zh-CN': 'MCP 请求过于频繁，请稍后重试。',
  },
  AI_DISABLED: { en: 'AI is disabled.', 'zh-CN': 'AI 服务未启用。' },
  AI_NOT_CONFIGURED: {
    en: 'Configure the AI binding or API key.',
    'zh-CN': '请配置 AI 绑定或 API Key。',
  },
  AI_UPSTREAM_ERROR: { en: 'AI service request failed.', 'zh-CN': 'AI 服务请求失败。' },
  AI_TIMEOUT: { en: 'AI request timed out.', 'zh-CN': 'AI 请求超时。' },
  AI_CANCELLED: { en: 'AI request cancelled.', 'zh-CN': 'AI 请求已取消。' },
  AI_INVALID_RESPONSE: {
    en: 'AI returned an invalid or incomplete response.',
    'zh-CN': 'AI 返回了无效或不完整的响应。',
  },

  INVALID_SCHEDULE_TIME: {
    en: 'Choose a future time within one year.',
    'zh-CN': '请选择一年内的未来时间。',
  },
  SCHEDULE_STATE_CONFLICT: {
    en: 'The schedule changed or sending has started. Refresh and try again.',
    'zh-CN': '发送计划已修改或邮件已开始发送，请刷新后重试。',
  },
  SUBJECT_TOO_LONG: {
    en: 'Subject must be at most 998 characters.',
    'zh-CN': '主题最多为 998 个字符。',
  },
  BODY_TOO_LONG: {
    en: 'Body must be at most 1,000,000 characters.',
    'zh-CN': '正文最多为 1,000,000 个字符。',
  },
  REFRESH_TOKEN_REQUIRED: { en: 'Please sign in again.', 'zh-CN': '请重新登录。' },
  INVALID_EMAIL: { en: 'Enter a valid email address.', 'zh-CN': '请输入有效的邮箱地址。' },
  AUTHENTICATION_REQUIRED: {
    en: 'Please sign in again.',
    'zh-CN': '请重新登录。',
  },
  INVALID_CREDENTIALS: {
    en: 'Email or password is incorrect.',
    'zh-CN': '邮箱或密码不正确。',
  },
  USER_BANNED: {
    en: 'This account has been disabled.',
    'zh-CN': '此账户已停用。',
  },
  PERMISSION_DENIED: {
    en: 'You do not have permission for this action.',
    'zh-CN': '你没有执行此操作的权限。',
  },
  REFRESH_TOKEN_INVALID: {
    en: 'Your session has expired. Please sign in again.',
    'zh-CN': '会话已失效，请重新登录。',
  },
  REFRESH_TOKEN_EXPIRED: {
    en: 'Your session has expired. Please sign in again.',
    'zh-CN': '会话已过期，请重新登录。',
  },
  INVALID_JSON: {
    en: 'The request is invalid. Please try again.',
    'zh-CN': '请求格式不正确，请重试。',
  },
  VALIDATION_ERROR: {
    en: 'Check the entered values and try again.',
    'zh-CN': '请检查填写的内容后重试。',
  },
  CONFLICTING_PRINCIPALS: {
    en: 'Your session is inconsistent. Please sign in again.',
    'zh-CN': '会话信息不一致，请重新登录。',
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    en: 'Please retry the action.',
    'zh-CN': '请重试此操作。',
  },
  IDEMPOTENCY_KEY_INVALID: {
    en: 'Please retry the action.',
    'zh-CN': '请重试此操作。',
  },
  IDEMPOTENCY_KEY_REUSED: {
    en: 'This request has changed. Please retry.',
    'zh-CN': '请求内容已变化，请重试。',
  },
  IDEMPOTENCY_CONFLICT: {
    en: 'A conflicting request was detected. Please retry.',
    'zh-CN': '请求发生冲突，请重试。',
  },
  IDEMPOTENCY_REQUEST_PENDING: {
    en: 'This action is still processing. Please wait.',
    'zh-CN': '操作仍在处理中，请稍候。',
  },
  IF_MATCH_REQUIRED: {
    en: 'Reload the current data before saving.',
    'zh-CN': '请刷新数据后再保存。',
  },
  IF_MATCH_INVALID: {
    en: 'Reload the current data before saving.',
    'zh-CN': '请刷新数据后再保存。',
  },
  STALE_IF_MATCH: {
    en: 'The data has changed. Reload before saving again.',
    'zh-CN': '数据已变化，请刷新后再保存。',
  },
  DOMAIN_NOT_FOUND: {
    en: 'Domain not found.',
    'zh-CN': '找不到该域名。',
  },
  DOMAIN_NOT_ACTIVE: {
    en: 'This domain is not active.',
    'zh-CN': '此域名尚未启用。',
  },
  DOMAIN_NAME_TAKEN: {
    en: 'This domain name is already in use.',
    'zh-CN': '此域名已被使用。',
  },
  DOMAIN_ADDRESS_TAKEN: {
    en: 'This domain address is already in use.',
    'zh-CN': '此域名地址已被使用。',
  },
  DOMAIN_ALREADY_MANAGED: {
    en: 'This domain is already managed.',
    'zh-CN': '此域名已纳入管理。',
  },
  DOMAIN_IN_USE: {
    en: 'This domain is still in use.',
    'zh-CN': '此域名仍在使用中。',
  },
  MAILBOX_NOT_FOUND: {
    en: 'Mailbox not found or unavailable.',
    'zh-CN': '邮箱不存在或不可用。',
  },
  MAILBOX_MEMBER_USER_NOT_FOUND: {
    en: 'User not found.',
    'zh-CN': '找不到该用户。',
  },
  MAILBOX_MEMBER_DUPLICATE: {
    en: 'This user is already a mailbox member.',
    'zh-CN': '此用户已是邮箱成员。',
  },
  MAILBOX_OWNER_CANNOT_BE_MEMBER: {
    en: 'The owner already has mailbox access.',
    'zh-CN': '所有者已拥有邮箱权限。',
  },
  MAILBOX_MEMBER_NOT_FOUND: {
    en: 'Mailbox member not found.',
    'zh-CN': '找不到该邮箱成员。',
  },
  MESSAGE_NOT_FOUND: {
    en: 'Message not found.',
    'zh-CN': '找不到该邮件。',
  },
  INVALID_CURSOR: {
    en: 'The list has changed. Start over to reload it.',
    'zh-CN': '列表已变化，请重新加载。',
  },
  ROLE_NOT_FOUND: {
    en: 'Role not found.',
    'zh-CN': '找不到该角色。',
  },
  ROLE_NAME_TAKEN: {
    en: 'This role name is already in use.',
    'zh-CN': '此角色名称已被使用。',
  },
  ROLE_PERMISSION_NOT_FOUND: {
    en: 'Permission not found.',
    'zh-CN': '找不到该权限。',
  },
  SYSTEM_ROLE_PROTECTED: {
    en: 'System roles cannot be changed here.',
    'zh-CN': '无法在此修改系统角色。',
  },
  ROLE_IN_USE: {
    en: 'This role is still assigned to users.',
    'zh-CN': '仍有用户使用此角色。',
  },
  SIGNATURE_NOT_FOUND: {
    en: 'Signature not found.',
    'zh-CN': '找不到该签名。',
  },
  SIGNATURE_ALREADY_EXISTS: {
    en: 'This domain already has a signature.',
    'zh-CN': '此域名已有签名。',
  },
  BLOCKLIST_ENTRY_NOT_FOUND: {
    en: 'Blocklist entry not found.',
    'zh-CN': '找不到该拦截条目。',
  },
  PROVIDER_CONNECTION_NOT_FOUND: {
    en: 'Email service connection not found.',
    'zh-CN': '找不到邮件服务连接。',
  },
  PROVIDER_CONNECTION_NOT_ACTIVE: {
    en: 'The email service connection is inactive.',
    'zh-CN': '邮件服务连接未启用。',
  },
  WEBHOOK_CONNECTION_NOT_FOUND: {
    en: 'Webhook connection not found.',
    'zh-CN': '找不到回调连接。',
  },
  WEBHOOK_NOT_CONFIGURED: {
    en: 'The webhook has not been configured.',
    'zh-CN': '尚未配置回调。',
  },
  WEBHOOK_SIGNATURE_MISSING: {
    en: 'The webhook signature is missing.',
    'zh-CN': '回调缺少签名。',
  },
  WEBHOOK_SIGNATURE_INVALID: {
    en: 'The webhook signature is invalid.',
    'zh-CN': '回调签名无效。',
  },
  REGISTRATION_CODE_INVALID: {
    en: 'The registration code is invalid.',
    'zh-CN': '注册码无效。',
  },
  REGISTRATION_CODE_EXPIRED: {
    en: 'The registration code has expired.',
    'zh-CN': '注册码已过期。',
  },
  REGISTRATION_CODE_REVOKED: {
    en: 'The registration code has been revoked.',
    'zh-CN': '注册码已撤销。',
  },
  REGISTRATION_CODE_EXHAUSTED: {
    en: 'The registration code has no uses left.',
    'zh-CN': '注册码的使用次数已耗尽。',
  },
  USER_EMAIL_TAKEN: {
    en: 'This email address is already in use.',
    'zh-CN': '此邮箱地址已被使用。',
  },
  USER_NOT_FOUND: {
    en: 'User not found.',
    'zh-CN': '找不到该用户。',
  },
  REGISTRATION_DISABLED: {
    en: 'Ask an administrator to create your account.',
    'zh-CN': '请联系管理员创建账户。',
  },
  INITIAL_PASSWORD_EXPIRED: {
    en: 'The initial password has expired. Contact an administrator.',
    'zh-CN': '初始密码已过期，请联系管理员。',
  },
  PASSWORD_CHANGE_REQUIRED: {
    en: 'Change your password to continue.',
    'zh-CN': '请先修改密码。',
  },
  SETUP_ALREADY_COMPLETE: {
    en: 'Setup has already been completed.',
    'zh-CN': '系统已完成初始化。',
  },
  SETUP_ADMINISTRATOR_EXISTS: {
    en: 'An administrator already exists.',
    'zh-CN': '管理员已存在。',
  },
  SETUP_ADMINISTRATOR_REQUIRED: {
    en: 'Create an administrator to continue.',
    'zh-CN': '请先创建管理员。',
  },
  SETUP_BREVO_ALREADY_CONFIGURED: {
    en: 'Brevo has already been configured.',
    'zh-CN': 'Brevo 已配置。',
  },
  SETUP_BREVO_NOT_CONFIGURED: {
    en: 'Configure Brevo to continue.',
    'zh-CN': '请先配置 Brevo。',
  },
  SETUP_CLAIM_INVALID_TOKEN: {
    en: 'The installation token is invalid.',
    'zh-CN': '安装令牌无效。',
  },
  SETUP_DOMAIN_REQUIRED: {
    en: 'Configure a domain to continue.',
    'zh-CN': '请先配置域名。',
  },
  SETUP_SESSION_REQUIRED: {
    en: 'Start setup again to continue.',
    'zh-CN': '请重新开始初始化。',
  },
  SETUP_SESSION_INVALID: {
    en: 'Your setup session has expired. Start again.',
    'zh-CN': '初始化会话已失效，请重新开始。',
  },
  MAILBOX_ACCESS_DENIED: {
    en: 'You do not have access to this mailbox.',
    'zh-CN': '你没有访问此邮箱的权限。',
  },
  PROVIDER_CONFIG_ERROR: {
    en: 'Check the email service configuration.',
    'zh-CN': '请检查邮件服务配置。',
  },
  PROVIDER_CONNECTION_FAILED: {
    en: 'Could not connect to the email service.',
    'zh-CN': '无法连接邮件服务。',
  },
  PROVIDER_SEND_FAILED: {
    en: 'The email service could not send this message.',
    'zh-CN': '邮件服务发送失败。',
  },
  BODY_TOO_LARGE: {
    en: 'The upload exceeds the allowed size.',
    'zh-CN': '上传内容超过大小限制。',
  },
  RATE_LIMITED: {
    en: 'Too many requests. Please try again later.',
    'zh-CN': '请求过于频繁，请稍后重试。',
  },
  LOCK_CONTENTION: {
    en: 'The system is busy. Please try again.',
    'zh-CN': '系统繁忙，请重试。',
  },
  INTERNAL: {
    en: 'Something went wrong. Please try again.',
    'zh-CN': '操作失败，请重试。',
  },
  AUDIT_ROW_INVALID: {
    en: 'Audit data could not be loaded. Contact an administrator.',
    'zh-CN': '审计数据无法加载，请联系管理员。',
  },
  USER_ROW_INVALID: {
    en: 'User data could not be loaded. Contact an administrator.',
    'zh-CN': '用户数据无法加载，请联系管理员。',
  },
  ATTACHMENT_UPLOAD_NOT_FOUND: {
    en: 'The attachment has expired or is unavailable. Upload it again.',
    'zh-CN': '附件已过期或不可用，请重新上传。',
  },
  AVATAR_INVALID: {
    en: 'Use a PNG, JPEG or WebP image.',
    'zh-CN': '请选择 PNG、JPEG 或 WebP 图片。',
  },
  AVATAR_NOT_FOUND: {
    en: 'Avatar not found. Upload it again.',
    'zh-CN': '头像不存在，请重新上传。',
  },
  NETWORK_ERROR: {
    en: 'Could not connect. Check your connection and retry.',
    'zh-CN': '无法连接，请检查网络后重试。',
  },
  INVALID_RESPONSE: {
    en: 'The server returned an invalid response. Please retry.',
    'zh-CN': '服务器响应异常，请重试。',
  },
  PASSWORD_MISMATCH: {
    en: 'Passwords do not match.',
    'zh-CN': '两次输入的密码不一致。',
  },
  PASSWORD_LENGTH: {
    en: 'Use 6–30 characters for your password.',
    'zh-CN': '密码长度应为 6–30 个字符。',
  },
  FIELD_REQUIRED: {
    en: 'This field is required.',
    'zh-CN': '此项为必填项。',
  },
  NOT_FOUND: {
    en: 'The requested resource was not found.',
    'zh-CN': '找不到所请求的资源。',
  },
  HTTP_ERROR: {
    en: 'The request failed. Please try again.',
    'zh-CN': '请求失败，请重试。',
  },
  UNKNOWN: {
    en: 'Something went wrong. Please try again.',
    'zh-CN': '操作失败，请重试。',
  },
  INVALID_REQUEST: {
    en: 'Check the entered values and try again.',
    'zh-CN': '请检查填写的内容后重试。',
  },
  DRAFT_LOAD_FAILED: {
    en: 'Something went wrong. Please try again.',
    'zh-CN': '操作失败，请重试。',
  },
  DRAFT_SAVE_FAILED: {
    en: 'Something went wrong. Please try again.',
    'zh-CN': '操作失败，请重试。',
  },
  DRAFT_CACHE_ERROR: {
    en: 'Something went wrong. Please try again.',
    'zh-CN': '操作失败，请重试。',
  },
} satisfies Record<ErrorCode, Record<Language, string>>;
export function errorMessage(code: string, locale: Language = getLanguage()): string {
  return (
    (errorMessages as Record<string, Record<Language, string>>)[code]?.[locale] ??
    errorMessages.INTERNAL[locale]
  );
}
