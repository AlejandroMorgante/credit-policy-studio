-- Portable demo dataset. Terraform creates the destination table first.
INSERT INTO `${PROJECT_ID}.credit_policy.applicants`
  (user_id, score_1, score_2, score_3, variable_1, variable_2, variable_3)
VALUES
  ('USR-1001', 742, 84, 91, 5200,  900, 46),
  ('USR-1002', 618, 58, 64, 3100, 1250, 18),
  ('USR-1003', 544, 72, 70, 2800,  600, 26),
  ('USR-1004', 691, 43, 59, 4400, 2100,  8),
  ('USR-1005', 775, 91, 87, 6800, 1100, 62),
  ('USR-1006', 582, 66, 52, 2500,  950, 14),
  ('USR-1007', 655, 77, 78, 3900,  850, 31),
  ('USR-1008', 509, 39, 45, 1900, 1200,  5),
  ('USR-1009', 707, 81, 76, 4700, 1350, 29),
  ('USR-1010', 569, 54, 68, 2300, 1000, 11);
