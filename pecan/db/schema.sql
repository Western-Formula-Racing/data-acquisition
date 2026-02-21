-- Create a table for storing user configurations
create table user_configs (
  user_id uuid references auth.users not null primary key,
  config_data jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Set up Row Level Security (RLS)
alter table user_configs enable row level security;

create policy "Users can view their own config."
  on user_configs for select
  using ( auth.uid() = user_id );

create policy "Users can insert their own config."
  on user_configs for insert
  with check ( auth.uid() = user_id );

create policy "Users can update their own config."
  on user_configs for update
  using ( auth.uid() = user_id );
