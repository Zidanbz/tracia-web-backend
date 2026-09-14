const bcrypt = require('bcrypt');

module.exports = {
  hashText: (text) => {
    return new Promise((resolve, reject) => {
      bcrypt.hash(text, 10, (err, hash) => {
        return err ? reject(err) : resolve(hash);
      });
    });
  },
  compareText: (password, hashPassword) => {
    return new Promise((resolve, reject) => {
      bcrypt.compare(password, hashPassword, (err, result) => {
        return result ? resolve(true) : resolve(false);
      });
    });
  },
};
