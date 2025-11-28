import { jobs } from '../db/schema';

export type Job = typeof jobs.$inferSelect;

export type JobInsert = typeof jobs.$inferInsert;

export type JobCreateInput = Omit<
	JobInsert,
	| 'id'
	| 'createdAt'
	| 'updatedAt'
	| 'status'
	| 'result'
	| 'errorMessage'
	| 'finishedAt'
	| 'retryCount'
>;

export type JobUpdateInput = Pick<
	Job,
	'status' | 'result' | 'errorMessage' | 'finishedAt' | 'retryCount'
>;

export type JobDbUpdateInput = Pick<
	Job,
	'status' | 'result' | 'errorMessage' | 'finishedAt' | 'retryCount' | 'updatedAt'
>;

export type JobPublic = Omit<Job, 'id'>;

export type JobResultSummary = {
	counts: {
		created: number;
		updated: number;
		deleted: number;
		unavailableChecked: number;
		authorityChanged: number;
	};
};