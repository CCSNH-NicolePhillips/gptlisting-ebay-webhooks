export const k = {
  job: (userId: string, jobId: string) => `job:${userId}:${jobId}`,
  price: (userId: string, jobId: string, groupId: string) => `price:${userId}:${jobId}:${groupId}`,
  override: (userId: string, jobId: string, groupId: string) => `taxo:ovr:${userId}:${jobId}:${groupId}`,
  jobsIdx: (userId: string) => `jobsidx:${userId}`,
};
