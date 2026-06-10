class CreateUsers < ActiveRecord::Migration[8.1]
  def change
    create_table :users do |t|
      t.string :email_address, null: false
      t.string :password_digest, null: false
      t.string :name
      t.string :avatar_url
      t.string :role, null: false, default: "user"
      t.string :locale, null: false, default: "en"
      t.string :polar_customer_id

      t.timestamps
    end
    add_index :users, :email_address, unique: true
    add_index :users, :polar_customer_id, unique: true
  end
end
