module.exports = {
  hooks: {
    'chat.userMessage'() { throw new Error('guard exploded'); },
    'tool.afterCall'() { throw new Error('after exploded'); },
  },
};
