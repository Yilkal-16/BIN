module.exports = {
  User: require('./User'),
  Cartela: require('./Cartela'),
  Game: require('./Game'),
  GameCartela: require('./GameCartela'),
  Transaction: require('./Transaction'),
  AdminRequest: require('./AdminRequest'),
  UserState: require('./UserState'),
  DrawSequence: require('./DrawSequence'),
  HouseWallet: require('./HouseWallet'),
  ...require('./Counter')
};
