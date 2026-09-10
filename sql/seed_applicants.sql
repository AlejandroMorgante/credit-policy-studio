-- Portable cascade demo dataset. Terraform creates the destination table first.
INSERT INTO `${PROJECT_ID}.credit_policy.applicants`
  (user_id, account_id, age, account_tenure_months, declared_income,
   estimated_monthly_debt, maximum_days_past_due_12m, completed_loans,
   is_restricted, has_recent_default, behavior_score, behavior_score_version,
   application_score, application_score_version)
VALUES
  ('USR-1001','ACC-1001',35,12,7000,500,0,3,FALSE,FALSE,0.15,'demo_behavior_v1',NULL,NULL),
  ('USR-1002','ACC-1002',35,12,5000,500,0,1,TRUE,FALSE,0.15,'demo_behavior_v1',NULL,NULL),
  ('USR-1003','ACC-1003',35,12,5000,500,0,1,FALSE,TRUE,0.15,'demo_behavior_v1',NULL,NULL),
  ('USR-1004','ACC-1004',19,12,5000,500,0,1,FALSE,FALSE,0.15,'demo_behavior_v1',NULL,NULL),
  ('USR-1005','ACC-1005',35,12,5000,500,40,1,FALSE,FALSE,0.15,'demo_behavior_v1',NULL,NULL),
  ('USR-1006','ACC-1006',35,12,800,500,0,1,FALSE,FALSE,0.15,'demo_behavior_v1',NULL,NULL),
  ('USR-1007','ACC-1007',35,12,6000,500,0,1,FALSE,FALSE,0.52,'demo_behavior_v1',NULL,NULL),
  ('USR-1008','ACC-1008',35,12,5000,500,0,1,FALSE,FALSE,0.80,'demo_behavior_v1',NULL,NULL);
