class Identity < ApplicationRecord
  belongs_to :user

  normalizes :email_address, with: ->(email) { email.to_s.strip.downcase }

  validates :provider, :uid, presence: true
  validates :uid, uniqueness: { scope: :provider }
end
