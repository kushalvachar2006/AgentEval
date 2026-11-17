
import mongoose from 'mongoose';
import { hasTenantFilter, hasTenantMatchStage } from '../lib/tenant.js';

const { Schema } = mongoose;

const QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'replaceOne'
];

export function tenantPlugin(schema) {
  schema.add({
    organizationId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true
    }
  });

  for (const op of QUERY_OPS) {
    schema.pre(op, function tenantGuard() {
      if (this.getOptions().skipTenantCheck) return;

      if (!hasTenantFilter(this.getFilter())) {
        throw new Error(
          `Tenant isolation: ${op} on ${this.model.modelName} requires organizationId`
        );
      }
    });
  }

  schema.pre('aggregate', function tenantAggregateGuard() {
    if (!hasTenantMatchStage(this.pipeline())) {
      throw new Error(
        'Tenant isolation: aggregate requires a leading $match on organizationId'
      );
    }
  });
}
