import mongoose from 'mongoose';

// 事前集計の1行。_id は aggMath.aggKey（リージョン|試合の種類|パッチ|帯|ロール|チャンピオン）。
// region は v6.4 で追加。region の無い行は v6.3 までの集計なので、起動時に作り直す（aggregate.js の ensureAggregates）。
// 加算するフィールド（games / wins / kills など）は $inc で増えるため strict: false にしている。
const champAggSchema = new mongoose.Schema(
  {
    _id: { type: String },
    region: String,
    q: Number,
    patch: String,
    band: String,
    role: String, // ALL / TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY / BAN / TOTAL
    champ: String
  },
  { strict: false, versionKey: false, collection: 'champ_agg_rows' }
);

champAggSchema.index({ region: 1, q: 1, patch: 1, band: 1, role: 1 });

export default mongoose.models.ChampAgg || mongoose.model('ChampAgg', champAggSchema);
